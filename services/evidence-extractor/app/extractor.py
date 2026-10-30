from __future__ import annotations

import io
import os
import re
import shutil
from dataclasses import asdict, dataclass, field
from pathlib import Path

import fitz
import pdfplumber
from PIL import Image

PARSER_VERSION = "feltus-universal-evidence-2.0.0"


@dataclass
class SpatialToken:
    token_id: str
    text: str
    bbox: list[float]
    confidence: float
    source_method: str


@dataclass
class TranscribedLine:
    line_number: int
    text: str
    bbox: list[float] | None
    tokens: list[SpatialToken] = field(default_factory=list)


@dataclass
class PageResult:
    page_number: int
    method: str
    raw_text: str
    character_count: int
    text_quality: float
    width: float
    height: float
    lines: list[TranscribedLine] = field(default_factory=list)
    tables: list[dict] = field(default_factory=list)
    needs_review: bool = False
    warning: str | None = None

    def to_contract(self) -> dict:
        return asdict(self)


@dataclass
class Extraction:
    page_count: int
    raw_text: str
    pages: list[PageResult] = field(default_factory=list)
    tables: list[dict] = field(default_factory=list)
    ocr_used: bool = False
    warnings: list[str] = field(default_factory=list)


def _text_quality(text: str) -> float:
    stripped = re.sub(r"\s+", "", text)
    if not stripped:
        return 0.0
    printable = sum(character.isprintable() for character in stripped) / len(stripped)
    alphanumeric = sum(character.isalnum() for character in stripped) / len(stripped)
    return min(1.0, printable * 0.35 + alphanumeric * 0.65)


def _bbox_union(tokens: list[SpatialToken]) -> list[float] | None:
    if not tokens:
        return None
    return [min(t.bbox[0] for t in tokens), min(t.bbox[1] for t in tokens), max(t.bbox[2] for t in tokens), max(t.bbox[3] for t in tokens)]


def _digital_page(page: fitz.Page, page_number: int) -> tuple[str, list[TranscribedLine]]:
    grouped: dict[tuple[int, int], list[tuple]] = {}
    for word in page.get_text("words", sort=True):
        key = (int(word[5]) if len(word) > 5 else 0, int(word[6]) if len(word) > 6 else len(grouped))
        grouped.setdefault(key, []).append(word)
    lines: list[TranscribedLine] = []
    for line_number, line_words in enumerate(grouped.values(), start=1):
        line_words.sort(key=lambda word: word[0])
        tokens = [SpatialToken(
            token_id=f"p{page_number}-l{line_number}-t{token_index}", text=str(word[4]),
            bbox=[round(float(word[0]), 3), round(float(word[1]), 3), round(float(word[2]), 3), round(float(word[3]), 3)],
            confidence=1.0, source_method="DIGITAL_TEXT",
        ) for token_index, word in enumerate(line_words, start=1)]
        lines.append(TranscribedLine(line_number, " ".join(t.text for t in tokens), _bbox_union(tokens), tokens))
    return "\n".join(line.text for line in lines), lines


def _find_tesseract(pytesseract_module) -> None:
    if shutil.which("tesseract"):
        return
    if os.name == "nt":
        candidates = [
            Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Tesseract-OCR" / "tesseract.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Tesseract-OCR" / "tesseract.exe",
        ]
        executable = next((candidate for candidate in candidates if candidate.is_file()), None)
        if executable:
            pytesseract_module.pytesseract.tesseract_cmd = str(executable)


def _ocr_page(page: fitz.Page, page_number: int, dpi: int, language: str) -> tuple[str, list[TranscribedLine]]:
    try:
        import pytesseract
        from pytesseract import Output
    except ImportError as exc:
        raise RuntimeError("pytesseract is not installed") from exc
    _find_tesseract(pytesseract)
    pix = page.get_pixmap(dpi=dpi, alpha=False)
    image = Image.open(io.BytesIO(pix.tobytes("png")))
    try:
        data = pytesseract.image_to_data(image, lang=language, output_type=Output.DICT)
    except Exception as exc:
        raise RuntimeError("Tesseract OCR is not installed or is not available") from exc
    x_scale, y_scale = float(page.rect.width) / image.width, float(page.rect.height) / image.height
    grouped: dict[tuple[int, int, int], list[SpatialToken]] = {}
    for index, value in enumerate(data.get("text", [])):
        text = str(value).strip()
        if not text:
            continue
        try:
            confidence = float(data["conf"][index])
        except (ValueError, TypeError):
            confidence = -1
        if confidence < 0:
            continue
        left, top = float(data["left"][index]), float(data["top"][index])
        width, height = float(data["width"][index]), float(data["height"][index])
        key = (int(data["block_num"][index]), int(data["par_num"][index]), int(data["line_num"][index]))
        grouped.setdefault(key, []).append(SpatialToken("", text, [round(left*x_scale,3), round(top*y_scale,3), round((left+width)*x_scale,3), round((top+height)*y_scale,3)], round(confidence/100,3), "SCANNED_OCR"))
    lines: list[TranscribedLine] = []
    for line_number, tokens in enumerate(grouped.values(), start=1):
        tokens.sort(key=lambda token: token.bbox[0])
        for token_index, token in enumerate(tokens, start=1):
            token.token_id = f"p{page_number}-l{line_number}-t{token_index}"
        lines.append(TranscribedLine(line_number, " ".join(t.text for t in tokens), _bbox_union(tokens), tokens))
    return "\n".join(line.text for line in lines), lines


def extract_pdf(path: Path, ocr_dpi: int = 200, ocr_language: str = "eng") -> Extraction:
    pages: list[PageResult] = []
    all_tables: list[dict] = []
    warnings: list[str] = []
    page_texts: list[str] = []
    ocr_used = False
    try:
        document = fitz.open(path)
    except Exception as exc:
        raise ValueError("The uploaded file is not a readable PDF") from exc
    if document.needs_pass:
        document.close()
        raise ValueError("Password-protected PDFs must be unlocked before upload")
    try:
        with pdfplumber.open(path) as plumber:
            for index, page in enumerate(document):
                page_number = index + 1
                embedded_text, embedded_lines = _digital_page(page, page_number)
                quality = _text_quality(embedded_text)
                use_ocr = len(re.sub(r"\s", "", embedded_text)) < 40 or quality < 0.58
                page_warning = None
                if use_ocr:
                    try:
                        page_text, page_lines = _ocr_page(page, page_number, ocr_dpi, ocr_language)
                        method, ocr_used = "SCANNED_OCR", True
                        page_warning = f"Page {page_number} used OCR because embedded text was insufficient."
                        warnings.append(page_warning)
                    except RuntimeError as exc:
                        page_text, page_lines = embedded_text, embedded_lines
                        method = "EMBEDDED_PARTIAL" if page_text.strip() else "OCR_UNAVAILABLE"
                        page_warning = f"Page {page_number} needed OCR but OCR was unavailable: {exc}"
                        warnings.append(page_warning)
                else:
                    page_text, page_lines, method = embedded_text, embedded_lines, "DIGITAL_TEXT"
                page_tables: list[dict] = []
                try:
                    extracted_tables = plumber.pages[index].extract_tables()
                except Exception as exc:
                    warnings.append(f"Page {page_number} table extraction could not complete: {exc}")
                    extracted_tables = []
                for table_index, table in enumerate(extracted_tables):
                    cleaned = [[cell.strip() if isinstance(cell, str) else cell for cell in row] for row in table]
                    if any(any(cell not in (None, "") for cell in row) for row in cleaned):
                        record = {"page_number": page_number, "table_index": table_index, "rows": cleaned}
                        page_tables.append(record); all_tables.append(record)
                pages.append(PageResult(page_number, method, page_text, len(page_text), round(_text_quality(page_text),3), round(float(page.rect.width),3), round(float(page.rect.height),3), page_lines, page_tables, not bool(page_text.strip()), page_warning))
                page_texts.append(f"--- PAGE {page_number} ---\n{page_text}")
    finally:
        document.close()
    return Extraction(len(pages), "\n\n".join(page_texts), pages, all_tables, ocr_used, warnings)
