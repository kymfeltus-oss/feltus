from __future__ import annotations

import hashlib
import os
import tempfile
import unittest
import uuid
from pathlib import Path

import fitz


class EvidenceExtractionTest(unittest.TestCase):
    def test_extraction_endpoint_requires_private_service_token(self) -> None:
        from app import main as extraction_main

        extraction_main.EXTRACTION_TOKEN = "a" * 48
        with self.assertRaises(extraction_main.HTTPException) as missing:
            extraction_main.require_extraction_token(None)
        self.assertEqual(missing.exception.status_code, 401)

        with self.assertRaises(extraction_main.HTTPException) as incorrect:
            extraction_main.require_extraction_token("Bearer " + "b" * 48)
        self.assertEqual(incorrect.exception.status_code, 401)

        self.assertIsNone(
            extraction_main.require_extraction_token("Bearer " + "a" * 48)
        )

    def test_pdf_contract_preserves_page_text_and_coordinates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            document_dir = root / "documents" / str(uuid.uuid4())
            document_dir.mkdir(parents=True)
            source = document_dir / "source.pdf"

            pdf = fitz.open()
            first = pdf.new_page()
            first.insert_text((72, 72), "FELTUS evidence page one")
            second = pdf.new_page()
            second.insert_text((72, 72), "FELTUS evidence page two")
            pdf.save(source)
            pdf.close()

            os.environ["FELTUS_DOCUMENT_ROOT"] = str(root / "documents")
            from app import main as extraction_main

            extraction_main.DOCUMENT_ROOT = (root / "documents").resolve()
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            result = extraction_main.extract_document(
                extraction_main.ExtractionRequest(
                    document_id=uuid.uuid4(),
                    storage_key=f"{document_dir.name}/source.pdf",
                    source_sha256=digest,
                )
            )

            self.assertEqual(result["status"], "VALIDATED")
            self.assertEqual(result["page_count"], 2)
            self.assertIn("FELTUS evidence page one", result["raw_text"])
            self.assertTrue(result["pages"][0]["lines"][0]["tokens"])
            self.assertEqual(len(result["source_sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
