from __future__ import annotations

import hashlib
import os
import secrets
import shutil
import uuid
from pathlib import Path, PurePosixPath

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .extractor import PARSER_VERSION, extract_pdf


DOCUMENT_ROOT = Path(
    os.getenv("FELTUS_DOCUMENT_ROOT", "/data/feltus-storage/documents")
).resolve()
MAX_DOCUMENT_BYTES = int(
    os.getenv("FELTUS_EXTRACTION_MAX_DOCUMENT_BYTES", str(20 * 1024 * 1024))
)
OCR_DPI = int(os.getenv("FELTUS_EXTRACTION_OCR_DPI", "200"))
OCR_LANGUAGE = os.getenv("FELTUS_EXTRACTION_OCR_LANGUAGE", "eng")
EXTRACTION_TOKEN = os.getenv("FELTUS_EVIDENCE_EXTRACTION_TOKEN", "")

app = FastAPI(
    title="FELTUS Internal Evidence Extractor",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


class ExtractionRequest(BaseModel):
    document_id: uuid.UUID
    storage_key: str = Field(min_length=1, max_length=500)
    source_sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")


def resolve_document_path(storage_key: str) -> Path:
    candidate = PurePosixPath(storage_key.replace("\\", "/"))
    if candidate.is_absolute() or ".." in candidate.parts:
        raise HTTPException(status_code=400, detail="Invalid document storage key")

    clean_parts = [part for part in candidate.parts if part not in ("", ".")]
    if not clean_parts:
        raise HTTPException(status_code=400, detail="Invalid document storage key")

    resolved = (DOCUMENT_ROOT / Path(*clean_parts)).resolve()
    try:
        resolved.relative_to(DOCUMENT_ROOT)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid document storage key") from exc
    return resolved


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def extract_document(request: ExtractionRequest) -> dict:
    source = resolve_document_path(request.storage_key)
    if source.suffix.lower() != ".pdf":
        raise HTTPException(status_code=415, detail="Only PDF extraction is supported")
    if not source.is_file():
        raise HTTPException(status_code=404, detail="Stored document file is unavailable")

    size_bytes = source.stat().st_size
    if size_bytes < 5:
        raise HTTPException(status_code=422, detail="PDF contains no usable data")
    if size_bytes > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=413, detail="PDF exceeds the configured extraction limit")

    source_sha256 = sha256_file(source)
    if source_sha256.lower() != request.source_sha256.lower():
        raise HTTPException(status_code=409, detail="Stored document fingerprint mismatch")

    try:
        extraction = extract_pdf(source, OCR_DPI, OCR_LANGUAGE)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    missing_pages = [page.page_number for page in extraction.pages if not page.raw_text.strip()]
    extracted_pages = extraction.page_count - len(missing_pages)
    errors = ["No text could be extracted from any page."] if extracted_pages == 0 else []
    warnings = list(extraction.warnings)
    if missing_pages:
        warnings.append(
            "No text was extracted from page(s) "
            + ", ".join(map(str, missing_pages))
            + ". Professional review is required."
        )

    extraction_confidence = (
        round(extracted_pages / extraction.page_count, 3)
        if extraction.page_count
        else 0.0
    )
    status = (
        "VALIDATED"
        if not errors and extraction_confidence == 1.0
        else "NEEDS_REVIEW"
    )

    return {
        "schema_version": "feltus-evidence-extraction-1.0",
        "extraction_id": str(uuid.uuid4()),
        "document_id": str(request.document_id),
        "source_sha256": source_sha256,
        "size_bytes": size_bytes,
        "parser_version": PARSER_VERSION,
        "status": status,
        "page_count": extraction.page_count,
        "pages_with_text": extracted_pages,
        "pages_needing_review": missing_pages,
        "extraction_confidence": extraction_confidence,
        "ocr_used": extraction.ocr_used,
        "raw_text": extraction.raw_text,
        "pages": [page.to_contract() for page in extraction.pages],
        "tables": extraction.tables,
        "warnings": warnings,
        "errors": errors,
    }


def require_extraction_token(authorization: str | None = Header(default=None)) -> None:
    if len(EXTRACTION_TOKEN) < 32:
        raise HTTPException(status_code=503, detail="Evidence extraction authentication is not configured")
    scheme, separator, supplied_token = (authorization or "").partition(" ")
    if (
        not separator
        or scheme.lower() != "bearer"
        or not secrets.compare_digest(supplied_token, EXTRACTION_TOKEN)
    ):
        raise HTTPException(status_code=401, detail="Evidence extraction authentication failed")


@app.get("/health")
def health() -> dict:
    if not shutil.which("tesseract"):
        raise HTTPException(status_code=503, detail="Tesseract OCR is unavailable")
    return {
        "status": "ok",
        "parser_version": PARSER_VERSION,
        "ocr": "available",
    }


@app.post("/extract")
def extract(
    request: ExtractionRequest,
    _authorized: None = Depends(require_extraction_token),
) -> dict:
    return extract_document(request)
