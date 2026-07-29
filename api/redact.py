from __future__ import annotations

import io
import json
import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

import pymupdf
from flask import Flask, jsonify, request, send_file

MAX_FILE_BYTES = 4_000_000
MAX_PAGES = 100
MAX_BLOCKS = 200
MAX_RECTS_PER_BLOCK = 100
REPLACEMENT = "REDACTED"

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_FILE_BYTES + 250_000


class RedactionError(ValueError):
    """A safe, user-facing redaction failure."""


@dataclass(frozen=True)
class PreparedBlock:
    page_index: int
    rects: tuple[pymupdf.Rect, ...]
    label_rect_index: int
    label_rotation: int
    source_font_size: float | None


def _normalized_text(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    return re.sub(r"\s+", " ", value).strip().casefold()


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RedactionError(f"{field} must be a number.")
    number = float(value)
    if not math.isfinite(number):
        raise RedactionError(f"{field} must be finite.")
    return number


def _prepare_blocks(
    document: pymupdf.Document, manifest: dict[str, Any]
) -> list[PreparedBlock]:
    raw_blocks = manifest.get("blocks")
    if not isinstance(raw_blocks, list) or not 1 <= len(raw_blocks) <= MAX_BLOCKS:
        raise RedactionError(
            f"Choose between 1 and {MAX_BLOCKS} redaction blocks."
        )

    prepared: list[PreparedBlock] = []
    for block_index, raw_block in enumerate(raw_blocks):
        if not isinstance(raw_block, dict):
            raise RedactionError(f"Block {block_index + 1} is invalid.")

        page_index = raw_block.get("pageIndex")
        if (
            isinstance(page_index, bool)
            or not isinstance(page_index, int)
            or page_index < 0
            or page_index >= document.page_count
        ):
            raise RedactionError(f"Block {block_index + 1} has an invalid page.")

        raw_rects = raw_block.get("rects")
        if (
            not isinstance(raw_rects, list)
            or not 1 <= len(raw_rects) <= MAX_RECTS_PER_BLOCK
        ):
            raise RedactionError(
                f"Block {block_index + 1} has an invalid rectangle count."
            )

        label_rect_index = raw_block.get("labelRectIndex")
        if (
            isinstance(label_rect_index, bool)
            or not isinstance(label_rect_index, int)
            or label_rect_index < 0
            or label_rect_index >= len(raw_rects)
        ):
            raise RedactionError(
                f"Block {block_index + 1} has an invalid label position."
            )

        if raw_block.get("replacement") != REPLACEMENT:
            raise RedactionError("Only the REDACTED replacement is supported.")

        page = document[page_index]
        page_bounds = page.rect
        pdf_to_mupdf = page.transformation_matrix
        converted: list[pymupdf.Rect] = []

        for rect_index, raw_rect in enumerate(raw_rects):
            if not isinstance(raw_rect, dict):
                raise RedactionError(
                    f"Rectangle {rect_index + 1} in block {block_index + 1} is invalid."
                )

            x0 = _number(raw_rect.get("x0"), "x0")
            y0 = _number(raw_rect.get("y0"), "y0")
            x1 = _number(raw_rect.get("x1"), "x1")
            y1 = _number(raw_rect.get("y1"), "y1")
            if x1 <= x0 or y1 <= y0:
                raise RedactionError("Redaction rectangles must have positive area.")

            # PDF.js emits raw PDF user-space coordinates. PyMuPDF page APIs use
            # top-left, unrotated page coordinates, so use the page matrix instead
            # of hand-flipping Y. This also respects CropBox offsets.
            mupdf_rect = pymupdf.Rect(x0, y0, x1, y1) * pdf_to_mupdf
            mupdf_rect = mupdf_rect & page_bounds
            if mupdf_rect.is_empty or mupdf_rect.width < 0.5 or mupdf_rect.height < 0.5:
                raise RedactionError(
                    f"Rectangle {rect_index + 1} is outside page {page_index + 1}."
                )
            converted.append(mupdf_rect)

        label_rect = converted[label_rect_index]
        label_rotation = _replacement_rotation(page, label_rect)
        prepared.append(
            PreparedBlock(
                page_index=page_index,
                rects=tuple(converted),
                label_rect_index=label_rect_index,
                label_rotation=label_rotation,
                source_font_size=_source_font_size(
                    page,
                    tuple(converted),
                    label_rect,
                    label_rotation,
                ),
            )
        )

    return prepared


def _rects_connect(first: pymupdf.Rect, second: pymupdf.Rect) -> bool:
    """Treat overlapping or edge-touching rectangles as connected."""
    return (
        first.x0 <= second.x1
        and second.x0 <= first.x1
        and first.y0 <= second.y1
        and second.y0 <= first.y1
    )


def _blocks_connect(first: PreparedBlock, second: PreparedBlock) -> bool:
    return first.page_index == second.page_index and any(
        _rects_connect(first_rect, second_rect)
        for first_rect in first.rects
        for second_rect in second.rects
    )


def _merge_connected_blocks(
    document: pymupdf.Document,
    blocks: list[PreparedBlock],
) -> list[PreparedBlock]:
    """Merge transitive connected components only for the exported document."""
    merged: list[PreparedBlock] = []
    unvisited = set(range(len(blocks)))
    bounds = [
        pymupdf.Rect(
            min(rect.x0 for rect in block.rects),
            min(rect.y0 for rect in block.rects),
            max(rect.x1 for rect in block.rects),
            max(rect.y1 for rect in block.rects),
        )
        for block in blocks
    ]

    while unvisited:
        first_index = min(unvisited)
        unvisited.remove(first_index)
        component = [first_index]
        pending = [first_index]

        while pending:
            current_index = pending.pop()
            connected = [
                candidate_index
                for candidate_index in unvisited
                if (
                    _rects_connect(
                        bounds[current_index],
                        bounds[candidate_index],
                    )
                    and _blocks_connect(
                        blocks[current_index],
                        blocks[candidate_index],
                    )
                )
            ]
            for candidate_index in connected:
                unvisited.remove(candidate_index)
                component.append(candidate_index)
                pending.append(candidate_index)

        if len(component) == 1:
            merged.append(blocks[first_index])
            continue

        component.sort()
        page_index = blocks[first_index].page_index
        rects = tuple(
            rect
            for block_index in component
            for rect in blocks[block_index].rects
        )
        label_rect_index = max(
            range(len(rects)),
            key=lambda index: rects[index].width * rects[index].height,
        )
        label_rect = rects[label_rect_index]
        label_rotation = _replacement_rotation(
            document[page_index],
            label_rect,
        )
        merged.append(
            PreparedBlock(
                page_index=page_index,
                rects=rects,
                label_rect_index=label_rect_index,
                label_rotation=label_rotation,
                source_font_size=_source_font_size(
                    document[page_index],
                    rects,
                    label_rect,
                    label_rotation,
                ),
            )
        )

    return merged


def _replacement_rotation(page: pymupdf.Page, rect: pymupdf.Rect) -> int:
    """Match the dominant text direction under a label, or the block's long axis."""
    best_rotation: int | None = None
    best_overlap = 0.0

    for text_block in page.get_text("dict").get("blocks", []):
        for line in text_block.get("lines", []):
            line_rect = pymupdf.Rect(line["bbox"])
            overlap = line_rect & rect
            if overlap.is_empty:
                continue

            overlap_area = overlap.width * overlap.height
            if overlap_area <= best_overlap:
                continue

            direction_x, direction_y = line["dir"]
            if abs(direction_x) >= abs(direction_y):
                rotation = 0 if direction_x >= 0 else 180
            else:
                # PyMuPDF's top-left coordinate system reports rotate=90 text as
                # advancing upward, and rotate=270 text as advancing downward.
                rotation = 90 if direction_y < 0 else 270

            best_rotation = rotation
            best_overlap = overlap_area

    if best_rotation is not None:
        return best_rotation
    return 90 if rect.height > rect.width else 0


def _source_font_size(
    page: pymupdf.Page,
    rects: tuple[pymupdf.Rect, ...],
    label_rect: pymupdf.Rect,
    rotation: int,
) -> float | None:
    """Choose the dominant covered source size for the replacement label."""
    scores: dict[float, float] = {}
    for text_block in page.get_text("dict").get("blocks", []):
        for line in text_block.get("lines", []):
            for span in line.get("spans", []):
                size = span.get("size")
                bbox = span.get("bbox")
                if (
                    isinstance(size, bool)
                    or not isinstance(size, (int, float))
                    or not bbox
                ):
                    continue

                span_rect = pymupdf.Rect(bbox)
                overlap_area = 0.0
                for rect in rects:
                    overlap = span_rect & rect
                    if not overlap.is_empty:
                        overlap_area += overlap.width * overlap.height
                if overlap_area <= 0:
                    continue

                normalized_size = round(float(size), 3)
                scores[normalized_size] = (
                    scores.get(normalized_size, 0.0) + overlap_area
                )

    ranked_sizes = sorted(
        scores.items(), key=lambda item: item[1], reverse=True
    )
    available_height = (
        label_rect.width
        if rotation in (90, 270)
        else label_rect.height
    )
    for font_size, _score in ranked_sizes:
        if font_size <= available_height:
            return font_size
    return None


def _replacement_font_size(
    rect: pymupdf.Rect,
    rotation: int,
    source_font_size: float | None,
) -> float:
    if source_font_size is not None:
        return source_font_size

    unit_width = pymupdf.get_text_length(
        REPLACEMENT, fontname="hebo", fontsize=1
    )
    vertical = rotation in (90, 270)
    available_width = rect.height if vertical else rect.width
    available_height = rect.width if vertical else rect.height
    width_limited = available_width * 0.88 / unit_width
    height_limited = available_height / 1.25
    size = min(10.0, width_limited, height_limited)
    if size < 4:
        raise RedactionError(
            "A selected block is too small to hold a readable REDACTED label. "
            "Enlarge that selection and try again."
        )
    return size


def _replacement_textbox_layout(
    rect: pymupdf.Rect,
    rotation: int,
    font_size: float,
) -> tuple[pymupdf.Rect, tuple[pymupdf.Point, pymupdf.Matrix] | None]:
    """Compress only the writing axis when the source-sized label is wider."""
    vertical = rotation in (90, 270)
    available_width = rect.height if vertical else rect.width
    natural_width = pymupdf.get_text_length(
        REPLACEMENT, fontname="hebo", fontsize=font_size
    )
    writing_scale = min(1.0, available_width * 0.9 / natural_width)
    if writing_scale >= 1:
        return rect, None

    if vertical:
        textbox = pymupdf.Rect(
            rect.x0,
            rect.y0,
            rect.x1,
            rect.y0 + rect.height / writing_scale,
        )
        matrix = pymupdf.Matrix(1, writing_scale)
    else:
        textbox = pymupdf.Rect(
            rect.x0,
            rect.y0,
            rect.x0 + rect.width / writing_scale,
            rect.y1,
        )
        matrix = pymupdf.Matrix(writing_scale, 1)
    return textbox, (rect.top_left, matrix)


def _remove_existing_annotations(document: pymupdf.Document) -> None:
    for page in document:
        for annotation in list(page.annots() or []):
            page.delete_annot(annotation)


def _assert_supported(document: pymupdf.Document) -> None:
    if document.needs_pass:
        raise RedactionError("Encrypted PDFs are not supported. Export an unlocked copy.")
    if document.page_count < 1 or document.page_count > MAX_PAGES:
        raise RedactionError(f"PDFs must contain 1 to {MAX_PAGES} pages.")
    if document.get_sigflags() > 0:
        raise RedactionError(
            "Signed PDFs are not supported because editing invalidates signatures. "
            "Use the unsigned original."
        )
    if document.is_form_pdf:
        raise RedactionError(
            "Active PDF forms are not supported in this first version. "
            "Flatten or export the form before redacting it."
        )


def _verify_output(
    output: bytes,
    prepared: list[PreparedBlock],
    selected_text: list[list[str]],
    original_redacted_count: int,
) -> None:
    with pymupdf.open(stream=output, filetype="pdf") as check:
        extracted = "\n".join(page.get_text("text") for page in check)
        if extracted.count(REPLACEMENT) < original_redacted_count + len(prepared):
            raise RedactionError(
                "The replacement text could not be verified. Enlarge the selected "
                "blocks and try again."
            )

        for block_index, block in enumerate(prepared):
            page = check[block.page_index]
            label_region = page.get_textbox(block.rects[block.label_rect_index])
            if REPLACEMENT.casefold() not in _normalized_text(label_region):
                raise RedactionError(
                    f"The label for block {block_index + 1} could not be verified."
                )

            for rect_index, rect in enumerate(block.rects):
                before = _normalized_text(selected_text[block_index][rect_index])
                after = _normalized_text(page.get_textbox(rect))
                if before and len(before) >= 3 and before in after:
                    raise RedactionError(
                        f"Content removal for block {block_index + 1} could not be verified."
                    )


def redact_pdf_bytes(source: bytes, manifest: dict[str, Any]) -> bytes:
    if len(source) > MAX_FILE_BYTES:
        raise RedactionError(
            "This deployment accepts PDFs up to 4 MB. Configure Private Blob "
            "before raising the limit."
        )
    if not source.startswith(b"%PDF-"):
        raise RedactionError("The uploaded file does not have a valid PDF signature.")

    try:
        document = pymupdf.open(stream=source, filetype="pdf")
    except Exception as exc:
        raise RedactionError("The uploaded PDF is malformed or unsupported.") from exc

    try:
        _assert_supported(document)
        prepared = _merge_connected_blocks(
            document,
            _prepare_blocks(document, manifest),
        )
        original_text = "\n".join(page.get_text("text") for page in document)
        original_redacted_count = original_text.count(REPLACEMENT)
        selected_text = [
            [document[block.page_index].get_textbox(rect) for rect in block.rects]
            for block in prepared
        ]

        _remove_existing_annotations(document)

        for block in prepared:
            page = document[block.page_index]
            for rect in block.rects:
                page.add_redact_annot(
                    rect,
                    fill=(1, 1, 1),
                    cross_out=False,
                )

        for page in document:
            page.apply_redactions(
                images=pymupdf.PDF_REDACT_IMAGE_PIXELS,
                graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
                text=pymupdf.PDF_REDACT_TEXT_REMOVE,
            )

        # Insert replacement text only after destructive removal. One logical
        # block can span many line rectangles but receives exactly one label.
        for block in prepared:
            page = document[block.page_index]
            label_rect = block.rects[block.label_rect_index]
            font_size = _replacement_font_size(
                label_rect,
                block.label_rotation,
                block.source_font_size,
            )
            textbox, morph = _replacement_textbox_layout(
                label_rect,
                block.label_rotation,
                font_size,
            )
            remaining = page.insert_textbox(
                textbox,
                REPLACEMENT,
                fontname="hebo",
                fontsize=font_size,
                align=pymupdf.TEXT_ALIGN_CENTER,
                color=(0, 0, 0),
                overlay=True,
                rotate=block.label_rotation,
                lineheight=1,
                morph=morph,
            )
            if remaining < 0:
                raise RedactionError(
                    "A REDACTED label did not fit. Enlarge that selection and try again."
                )

        document.scrub(
            attached_files=True,
            clean_pages=True,
            embedded_files=True,
            hidden_text=False,
            javascript=True,
            metadata=True,
            redactions=False,
            remove_links=True,
            reset_fields=True,
            reset_responses=True,
            thumbnails=True,
            xml_metadata=True,
        )

        output = document.tobytes(
            garbage=4,
            clean=True,
            deflate=True,
            use_objstms=1,
        )
    finally:
        document.close()

    _verify_output(output, prepared, selected_text, original_redacted_count)
    return output


@app.post("/api/redact")
def redact_route():
    upload = request.files.get("file")
    manifest_value = request.form.get("manifest")
    if upload is None or manifest_value is None:
        return jsonify(error="A PDF and redaction manifest are required."), 400

    try:
        manifest = json.loads(manifest_value)
        if not isinstance(manifest, dict):
            raise RedactionError("The redaction manifest is invalid.")
        output = redact_pdf_bytes(upload.read(MAX_FILE_BYTES + 1), manifest)
    except json.JSONDecodeError:
        return jsonify(error="The redaction manifest is not valid JSON."), 400
    except RedactionError as exc:
        return jsonify(error=str(exc)), 422
    except Exception:
        app.logger.exception("PDF redaction failed")
        return jsonify(error="The PDF could not be safely redacted."), 500

    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "-", upload.filename or "document")
    safe_stem = re.sub(r"\.pdf$", "", safe_stem, flags=re.IGNORECASE).strip(".-")
    filename = f"{safe_stem or 'document'}-redacted.pdf"
    return send_file(
        io.BytesIO(output),
        mimetype="application/pdf",
        as_attachment=True,
        download_name=filename,
        max_age=0,
    )
