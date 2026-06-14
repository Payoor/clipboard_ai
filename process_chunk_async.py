import hashlib
import mimetypes
from pathlib import Path
from datetime import datetime


def calculate_chunk_hash(chunk_file: Path):
    hash_md5 = hashlib.md5()

    with open(chunk_file, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)

    return hash_md5.hexdigest()


def validate_chunk_headers(chunk_file: Path):
    try:
        with open(chunk_file, "rb") as f:
            header = f.read(1024)

        return any(sig in header for sig in [b"ftyp", b"moov", b"mdat"])
    except Exception as e:
        print(f"[VALIDATION] Error: {e}")
        return False


def extract_chunk_metadata(chunk_file: Path):
    stat = chunk_file.stat()

    return {
        "filename": chunk_file.name,
        "size": stat.st_size,
        "created": datetime.fromtimestamp(stat.st_ctime).isoformat(),
        "mime_type": mimetypes.guess_type(str(chunk_file))[0],
    }


def virus_scan(chunk_file: Path):
    return {
        "clean": True,
        "engine": "placeholder",
    }


def generate_thumbnail_from_chunk(chunk_file: Path):
    thumbnail_path = chunk_file.parent / f"{chunk_file.stem}_thumbnail.jpg"
    thumbnail_path.touch(exist_ok=True)
    return str(thumbnail_path)


def compress_chunk(chunk_file: Path):
    return str(chunk_file)


def upload_to_cloud(chunk_file: Path, cloud_key: str):
    print(f"[CLOUD] Uploading {chunk_file} -> {cloud_key}")

    return {
        "uploaded": True,
        "cloud_key": cloud_key,
    }


def store_chunk_info(session_id, chunk_number, info):
    print(f"[DB] session={session_id} chunk={chunk_number}")
    print(info)


def process_chunk_async(session_id, chunk_number, chunk_file, metadata):
    print(f"[ASYNC] Processing chunk {chunk_number}")

    chunk_hash = calculate_chunk_hash(chunk_file)
    is_valid = validate_chunk_headers(chunk_file)
    video_info = extract_chunk_metadata(chunk_file)
    virus_result = virus_scan(chunk_file)

    thumbnail_path = None

    if chunk_number == 0:
        thumbnail_path = generate_thumbnail_from_chunk(chunk_file)

    compressed_path = compress_chunk(chunk_file)

    upload_result = upload_to_cloud(
        chunk_file,
        f"{session_id}/chunk_{chunk_number}",
    )

    result = {
        "chunk": chunk_number,
        "hash": chunk_hash,
        "valid": is_valid,
        "metadata": video_info,
        "virus_scan": virus_result,
        "thumbnail": thumbnail_path,
        "compressed": compressed_path,
        "cloud": upload_result,
        "original_metadata": metadata,
    }

    store_chunk_info(session_id, chunk_number, result)

    print(f"[ASYNC] Completed processing chunk {chunk_number}")

    return result