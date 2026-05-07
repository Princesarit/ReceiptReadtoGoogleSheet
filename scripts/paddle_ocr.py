import json
import os
import sys
from pathlib import Path


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))


def collect_text_from_old_result(result):
    entries = []

    for page in result or []:
        for item in page or []:
            if not item or len(item) < 2:
                continue

            text_score = item[1]
            if isinstance(text_score, (list, tuple)) and text_score:
                text = text_score[0]
                if text:
                    entries.append({
                        "text": str(text),
                        "box": normalize_box(item[0]),
                    })

    return entries


def normalize_box(box):
    if box is None:
        return None

    try:
        flat_box = [float(value) for value in box]
        if len(flat_box) == 4:
            x1, y1, x2, y2 = flat_box
            return [float(x1), float(y1), float(x2), float(y2)]
    except Exception:
        pass

    try:
        points = []
        for point in box:
            if len(point) >= 2:
                points.append((float(point[0]), float(point[1])))

        if not points:
            return None

        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        return [min(xs), min(ys), max(xs), max(ys)]
    except Exception:
        return None


def first_present(data, names):
    for name in names:
        value = data.get(name)
        if value is not None:
            return value

    return []


def collect_text_from_new_result(result):
    entries = []

    for item in result or []:
        data = getattr(item, "json", None)
        if callable(data):
            data = data()
        elif hasattr(item, "res"):
            data = item.res
        elif isinstance(item, dict):
            data = item

        if not isinstance(data, dict):
            continue

        if isinstance(data.get("res"), dict):
            data = data["res"]

        rec_texts = data.get("rec_texts") or data.get("texts") or []
        boxes = first_present(data, ["rec_boxes", "rec_polys", "dt_polys", "boxes"])

        for index, text in enumerate(rec_texts):
            if not text:
                continue

            box = boxes[index] if index < len(boxes) else None
            entries.append({
                "text": str(text),
                "box": normalize_box(box),
            })

    return entries


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "Missing image path."})
        return 2

    image_path = Path(sys.argv[1])
    if not image_path.exists():
        emit({"ok": False, "error": f"Image not found: {image_path}"})
        return 2

    try:
        from paddleocr import PaddleOCR
    except Exception as error:
        emit({
            "ok": False,
            "error": (
                "PaddleOCR is not installed in this Python environment. "
                "Install paddlepaddle and paddleocr, then set PADDLE_OCR_PYTHON if needed. "
                f"Import error: {error}"
            ),
        })
        return 3

    # PP-OCRv5 (and its native deps: paddle, oneDNN, glog) write colored progress
    # text directly to OS stdout fd, which corrupts our JSON output.
    # Redirect at the file-descriptor level so native libraries are also captured.
    sys.stdout.flush()
    saved_stdout_fd = os.dup(1)
    stdout_restored = False

    def restore_stdout():
        nonlocal stdout_restored
        if stdout_restored:
            return
        try:
            sys.stdout.flush()
        except Exception:
            pass
        os.dup2(saved_stdout_fd, 1)
        os.close(saved_stdout_fd)
        stdout_restored = True

    try:
        os.dup2(2, 1)
        try:
            ocr = PaddleOCR(
                lang="en",
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
            )
            result = ocr.predict(str(image_path))
            entries = collect_text_from_new_result(result)
        except TypeError:
            ocr = PaddleOCR(lang="en", use_angle_cls=True, show_log=False)
            result = ocr.ocr(str(image_path), cls=True)
            entries = collect_text_from_old_result(result)
    except Exception as error:
        restore_stdout()
        emit({"ok": False, "error": f"PaddleOCR failed: {error}"})
        return 4
    finally:
        restore_stdout()

    lines = [entry["text"] for entry in entries]
    emit({
        "ok": True,
        "engine": "paddleocr",
        "text": "\n".join(lines),
        "lines": lines,
        "entries": entries,
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
