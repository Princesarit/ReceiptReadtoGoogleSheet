import json
import sys
from pathlib import Path


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))


def collect_text_from_old_result(result):
    lines = []

    for page in result or []:
        for item in page or []:
            if not item or len(item) < 2:
                continue

            text_score = item[1]
            if isinstance(text_score, (list, tuple)) and text_score:
                text = text_score[0]
                if text:
                    lines.append(str(text))

    return lines


def collect_text_from_new_result(result):
    lines = []

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
        lines.extend(str(text) for text in rec_texts if text)

    return lines


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

    try:
        try:
            ocr = PaddleOCR(
                lang="en",
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
            )
            result = ocr.predict(str(image_path))
            lines = collect_text_from_new_result(result)
        except TypeError:
            ocr = PaddleOCR(lang="en", use_angle_cls=True, show_log=False)
            result = ocr.ocr(str(image_path), cls=True)
            lines = collect_text_from_old_result(result)

        emit({
            "ok": True,
            "engine": "paddleocr",
            "text": "\n".join(lines),
            "lines": lines,
        })
        return 0
    except Exception as error:
        emit({"ok": False, "error": f"PaddleOCR failed: {error}"})
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
