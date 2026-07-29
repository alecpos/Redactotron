from __future__ import annotations

import unittest

import pymupdf

from api.redact import REPLACEMENT, RedactionError, redact_pdf_bytes


def pdf_rect(page: pymupdf.Page, rect: pymupdf.Rect) -> dict[str, float]:
    converted = rect * ~page.transformation_matrix
    return {
        "x0": converted.x0,
        "y0": converted.y0,
        "x1": converted.x1,
        "y1": converted.y1,
    }


def block(block_id: str, page_index: int, rects: list[dict[str, float]]) -> dict:
    return {
        "id": block_id,
        "pageIndex": page_index,
        "rects": rects,
        "labelRectIndex": max(
            range(len(rects)),
            key=lambda index: (
                rects[index]["x1"] - rects[index]["x0"]
            )
            * (rects[index]["y1"] - rects[index]["y0"]),
        ),
        "replacement": REPLACEMENT,
        "appearance": "text-replacement",
    }


class RedactionEngineTests(unittest.TestCase):
    def make_resume(self) -> tuple[bytes, list[dict[str, float]]]:
        document = pymupdf.open()
        page = document.new_page(width=612, height=792)
        page.insert_text((72, 92), "Information", fontsize=16, fontname="hebo")
        page.insert_text((72, 132), "first name: Alice", fontsize=12)
        page.insert_text((72, 158), "last name: Johnson", fontsize=12)
        page.insert_text(
            (72, 184), "Address: 44 Redwood Lane", fontsize=12
        )
        page.insert_text((72, 240), "Experience", fontsize=16, fontname="hebo")
        page.insert_text(
            (72, 270), "Built reliable systems for customers.", fontsize=12
        )
        document.set_metadata(
            {
                "title": "Confidential resume",
                "author": "Alice Johnson",
                "subject": "Private",
            }
        )

        targets = [
            pdf_rect(page, page.search_for("Alice")[0]),
            pdf_rect(page, page.search_for("Johnson")[0]),
            pdf_rect(page, page.search_for("44 Redwood Lane")[0]),
        ]
        output = document.tobytes()
        document.close()
        return output, targets

    def test_three_blocks_insert_three_labels_and_remove_original_text(self):
        source, targets = self.make_resume()
        manifest = {
            "blocks": [
                block("first", 0, [targets[0]]),
                block("last", 0, [targets[1]]),
                block("address", 0, [targets[2]]),
            ]
        }

        output = redact_pdf_bytes(source, manifest)
        with pymupdf.open(stream=output, filetype="pdf") as result:
            text = result[0].get_text("text")
            self.assertNotIn("Alice", text)
            self.assertNotIn("Johnson", text)
            self.assertNotIn("44 Redwood Lane", text)
            self.assertEqual(text.count(REPLACEMENT), 3)
            self.assertIn("Experience", text)
            self.assertEqual(result.metadata.get("author"), "")
            replacement_spans = [
                span
                for text_block in result[0].get_text("dict")["blocks"]
                for line in text_block.get("lines", [])
                for span in line.get("spans", [])
                if REPLACEMENT in span["text"]
            ]
            replacement_spans.sort(key=lambda span: span["bbox"][1])
            for span, target in zip(replacement_spans, targets, strict=True):
                replacement_height = pymupdf.Rect(span["bbox"]).height
                target_height = target["y1"] - target["y0"]
                self.assertAlmostEqual(
                    replacement_height,
                    target_height,
                    delta=0.1,
                )

    def test_one_multiline_block_inserts_one_label(self):
        source, targets = self.make_resume()
        manifest = {"blocks": [block("identity", 0, targets)]}

        output = redact_pdf_bytes(source, manifest)
        with pymupdf.open(stream=output, filetype="pdf") as result:
            text = result[0].get_text("text")
            self.assertEqual(text.count(REPLACEMENT), 1)
            self.assertNotIn("Alice", text)
            self.assertNotIn("Johnson", text)
            self.assertNotIn("44 Redwood Lane", text)

    def test_connected_blocks_merge_only_for_export(self):
        document = pymupdf.open()
        page = document.new_page(width=500, height=300)
        page.insert_text((72, 120), "Alice Johnson", fontsize=16)
        alice = pdf_rect(page, page.search_for("Alice")[0])
        johnson = pdf_rect(page, page.search_for("Johnson")[0])
        alice["x1"] = johnson["x0"] + 2
        source = document.tobytes()
        document.close()
        manifest = {
            "blocks": [
                block("first-name", 0, [alice]),
                block("last-name", 0, [johnson]),
            ]
        }

        output = redact_pdf_bytes(source, manifest)
        with pymupdf.open(stream=output, filetype="pdf") as result:
            text = result[0].get_text("text")
            self.assertNotIn("Alice", text)
            self.assertNotIn("Johnson", text)
            self.assertEqual(text.count(REPLACEMENT), 1)

        self.assertEqual(len(manifest["blocks"]), 2)

    def test_connected_block_merging_is_transitive(self):
        document = pymupdf.open()
        page = document.new_page(width=500, height=300)
        page.insert_text((72, 120), "Alpha Bravo Charlie", fontsize=16)
        targets = [
            pdf_rect(page, page.search_for(word)[0])
            for word in ("Alpha", "Bravo", "Charlie")
        ]
        targets[0]["x1"] = targets[1]["x0"] + 2
        targets[1]["x1"] = targets[2]["x0"] + 2
        source = document.tobytes()
        document.close()
        manifest = {
            "blocks": [
                block(f"word-{index}", 0, [target])
                for index, target in enumerate(targets)
            ]
        }

        output = redact_pdf_bytes(source, manifest)
        with pymupdf.open(stream=output, filetype="pdf") as result:
            self.assertEqual(
                result[0].get_text("text").count(REPLACEMENT),
                1,
            )

    def test_replacement_uses_the_covered_text_size_and_line_height(self):
        document = pymupdf.open()
        page = document.new_page(width=500, height=300)
        source_text = "Sensitive source text"
        page.insert_text((72, 120), source_text, fontsize=16)
        target = page.search_for(source_text)[0]
        source = document.tobytes()
        manifest = {
            "blocks": [block("same-size", 0, [pdf_rect(page, target)])]
        }
        document.close()

        output = redact_pdf_bytes(source, manifest)
        with pymupdf.open(stream=output, filetype="pdf") as result:
            replacement_span = next(
                span
                for text_block in result[0].get_text("dict")["blocks"]
                for line in text_block.get("lines", [])
                for span in line.get("spans", [])
                if REPLACEMENT in span["text"]
            )
            replacement_rect = pymupdf.Rect(replacement_span["bbox"])
            self.assertAlmostEqual(replacement_span["size"], 16, places=3)
            self.assertGreaterEqual(replacement_rect.y0, target.y0 - 0.1)
            self.assertLessEqual(replacement_rect.y1, target.y1 + 0.1)

    def test_mixed_size_selection_uses_one_covered_font_size(self):
        document = pymupdf.open()
        page = document.new_page(width=500, height=300)
        page.insert_text((72, 100), "Sensitive heading text", fontsize=14)
        page.insert_text((72, 140), "Sensitive detail text", fontsize=9)
        targets = [
            page.search_for("Sensitive heading text")[0],
            page.search_for("Sensitive detail text")[0],
        ]
        source = document.tobytes()
        manifest = {
            "blocks": [
                block(
                    "mixed-size",
                    0,
                    [pdf_rect(page, target) for target in targets],
                )
            ]
        }
        document.close()

        output = redact_pdf_bytes(source, manifest)
        with pymupdf.open(stream=output, filetype="pdf") as result:
            replacement_span = next(
                span
                for text_block in result[0].get_text("dict")["blocks"]
                for line in text_block.get("lines", [])
                for span in line.get("spans", [])
                if REPLACEMENT in span["text"]
            )
            self.assertIn(round(replacement_span["size"], 3), {9.0, 14.0})

    def test_rejects_out_of_page_coordinates(self):
        source, _ = self.make_resume()
        manifest = {
            "blocks": [
                block(
                    "outside",
                    0,
                    [{"x0": 9000, "y0": 9000, "x1": 9100, "y1": 9100}],
                )
            ]
        }

        with self.assertRaisesRegex(RedactionError, "outside page"):
            redact_pdf_bytes(source, manifest)

    def test_rejects_tiny_label_area(self):
        source, targets = self.make_resume()
        tiny = dict(targets[0])
        tiny["x1"] = tiny["x0"] + 5
        tiny["y1"] = tiny["y0"] + 5
        manifest = {"blocks": [block("tiny", 0, [tiny])]}

        with self.assertRaisesRegex(RedactionError, "too small"):
            redact_pdf_bytes(source, manifest)

    def test_rotated_text_gets_a_rotated_label_in_the_same_place(self):
        document = pymupdf.open()
        page = document.new_page(width=500, height=500)
        email = "jane.doe@example.com"
        page.insert_text(
            (100, 350),
            f"Rotated text {email}",
            fontsize=16,
            rotate=90,
        )
        target = page.search_for(email)[0]
        source = document.tobytes()
        manifest = {
            "blocks": [block("rotated-email", 0, [pdf_rect(page, target)])]
        }
        document.close()

        output = redact_pdf_bytes(source, manifest)
        with pymupdf.open(stream=output, filetype="pdf") as result:
            page = result[0]
            text = page.get_text("text")
            self.assertNotIn(email, text)
            self.assertEqual(text.count(REPLACEMENT), 1)

            replacement_line = next(
                line
                for text_block in page.get_text("dict")["blocks"]
                for line in text_block.get("lines", [])
                if any(
                    REPLACEMENT in span["text"]
                    for span in line["spans"]
                )
            )
            self.assertAlmostEqual(replacement_line["dir"][0], 0, places=3)
            self.assertAlmostEqual(replacement_line["dir"][1], -1, places=3)
            self.assertFalse(
                (pymupdf.Rect(replacement_line["bbox"]) & target).is_empty
            )

    def test_page_rotation_does_not_double_rotate_the_label(self):
        document = pymupdf.open()
        page = document.new_page(width=500, height=300)
        email = "jane.doe@example.com"
        page.insert_text((100, 120), email, fontsize=16)
        page.set_rotation(90)
        target = page.search_for(email)[0]
        source = document.tobytes()
        manifest = {
            "blocks": [block("rotated-page-email", 0, [pdf_rect(page, target)])]
        }
        document.close()

        output = redact_pdf_bytes(source, manifest)
        with pymupdf.open(stream=output, filetype="pdf") as result:
            page = result[0]
            replacement_line = next(
                line
                for text_block in page.get_text("dict")["blocks"]
                for line in text_block.get("lines", [])
                if any(
                    REPLACEMENT in span["text"]
                    for span in line["spans"]
                )
            )
            self.assertEqual(page.rotation, 90)
            self.assertAlmostEqual(replacement_line["dir"][0], 1, places=3)
            self.assertAlmostEqual(replacement_line["dir"][1], 0, places=3)

    def test_export_scrubs_annotations_links_attachments_and_metadata(self):
        source, targets = self.make_resume()
        with pymupdf.open(stream=source, filetype="pdf") as document:
            page = document[0]
            annotation = page.add_text_annot((500, 100), "private note")
            annotation.update()
            page.insert_link(
                {
                    "kind": pymupdf.LINK_URI,
                    "from": pymupdf.Rect(72, 300, 200, 320),
                    "uri": "https://example.com/?private=value",
                }
            )
            document.embfile_add("private.txt", b"private attachment")
            source = document.tobytes()

        output = redact_pdf_bytes(
            source, {"blocks": [block("first", 0, [targets[0]])]}
        )

        with pymupdf.open(stream=output, filetype="pdf") as result:
            self.assertEqual(result.embfile_names(), [])
            self.assertIsNone(result[0].first_annot)
            self.assertEqual(result[0].get_links(), [])
            self.assertEqual(result.metadata.get("author"), "")


if __name__ == "__main__":
    unittest.main()
