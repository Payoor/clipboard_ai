import importlib


def check(name, alias=None):
    try:
        importlib.import_module(name)
        print(f"[OK] {alias or name}")
    except Exception as e:
        print(f"[FAIL] {alias or name} -> {e}")


def test_torch():
    try:
        import torch
        print("[OK] torch version:", torch.__version__)
        print("[OK] cuda available:", torch.cuda.is_available())
    except Exception as e:
        print("[FAIL] torch ->", e)


def test_cv():
    try:
        import cv2
        print("[OK] cv2 version:", cv2.__version__)
    except Exception as e:
        print("[FAIL] cv2 ->", e)


def test_numpy():
    import numpy as np
    print("[OK] numpy version:", np.__version__)


def test_audio():
    try:
        import librosa
        import soundfile
        print("[OK] librosa:", librosa.__version__)
        print("[OK] soundfile OK")
    except Exception as e:
        print("[FAIL] audio stack ->", e)


def test_whisper():
    try:
        from faster_whisper import WhisperModel
        print("[OK] faster-whisper imported")
    except Exception as e:
        print("[FAIL] faster-whisper ->", e)


def test_transformers():
    try:
        import transformers
        print("[OK] transformers:", transformers.__version__)
    except Exception as e:
        print("[FAIL] transformers ->", e)


def test_clip():
    try:
        import open_clip
        print("[OK] open_clip imported")
    except Exception as e:
        print("[FAIL] open_clip ->", e)


def main():
    print("\n=== BASIC IMPORT TESTS ===\n")

    check("flask")
    check("requests")
    check("sklearn", "scikit-learn")
    check("PIL", "Pillow")
    check("mediapipe")
    check("speechbrain")
    check("pyannote.audio", "pyannote")

    print("\n=== CORE STACK TESTS ===\n")
    test_numpy()
    test_torch()
    test_cv()
    test_audio()
    test_whisper()
    test_transformers()
    test_clip()

    print("\n=== DONE ===")


if __name__ == "__main__":
    main()