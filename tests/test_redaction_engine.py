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

    def test_rotated_page_and_rotated_text_receive_searchable_labels(self):
        document = pymupdf.open()
        rotated_page = document.new_page(width=612, height=792)
        rotated_page.insert_text(
            (72, 108), "Rotated page 123-45-6789", fontsize=12
        )
        rotated_page_target = pdf_rect(
            rotated_page, rotated_page.search_for("123-45-6789")[0]
        )
        rotated_page.set_rotation(90)

        rotated_text_page = document.new_page(width=612, height=792)
        rotated_text_page.insert_text(
            (120, 700),
            "jane.doe@example.com",
            fontsize=12,
            rotate=90,
        )
        rotated_text_target = pdf_rect(
            rotated_text_page,
            rotated_text_page.search_for("jane.doe@example.com")[0],
        )
        source = document.tobytes()
        document.close()

        manifest = {
            "blocks": [
                block("rotated-page", 0, [rotated_page_target]),
                block("rotated-text", 1, [rotated_text_target]),
            ]
        }
        output = redact_pdf_bytes(source, manifest)

        with pymupdf.open(stream=output, filetype="pdf") as result:
            text = "\n".join(page.get_text("text") for page in result)
            self.assertNotIn("123-45-6789", text)
            self.assertNotIn("jane.doe@example.com", text)
            self.assertEqual(text.count(REPLACEMENT), 2)

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
