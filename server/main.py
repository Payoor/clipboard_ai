from flask import Flask, request, jsonify
from pathlib import Path
import math
import uuid
import json
from werkzeug.utils import secure_filename
from concurrent.futures import ThreadPoolExecutor

from redis_config import redis_client
from process_chunk_async import process_chunk_async

executor = ThreadPoolExecutor(max_workers=4)

CHUNK_SIZE = 10 * 1024 * 1024
SESSION_TTL_SECONDS = 60 * 60

app = Flask(__name__)

UPLOAD_FOLDER = Path(__file__).parent / "uploads"
UPLOAD_FOLDER.mkdir(exist_ok=True)


def session_key(session_id):
    return f"upload_session:{session_id}"


def chunk_result_key(session_id, chunk_number):
    return f"upload_session:{session_id}:chunk:{chunk_number}:result"


def save_session(session_id, session_data):
    redis_client.set(
        session_key(session_id),
        json.dumps(session_data),
        ex=SESSION_TTL_SECONDS
    )


def get_session(session_id):
    raw = redis_client.get(session_key(session_id))

    if not raw:
        return None

    return json.loads(raw)


def mark_chunk_received(session_id, chunk_number):
    redis_client.sadd(
        f"upload_session:{session_id}:received_chunks",
        chunk_number
    )

    redis_client.expire(
        f"upload_session:{session_id}:received_chunks",
        SESSION_TTL_SECONDS
    )


def get_received_chunk_count(session_id):
    return redis_client.scard(
        f"upload_session:{session_id}:received_chunks"
    )


def get_received_chunks(session_id):
    return sorted(
        int(x)
        for x in redis_client.smembers(
            f"upload_session:{session_id}:received_chunks"
        )
    )


def chunk_processed_callback(session_id, chunk_number, future):
    try:
        result = future.result()

        redis_client.set(
            chunk_result_key(session_id, chunk_number),
            json.dumps(result),
            ex=SESSION_TTL_SECONDS
        )

        redis_client.sadd(
            f"upload_session:{session_id}:processed_chunks",
            chunk_number
        )

        redis_client.expire(
            f"upload_session:{session_id}:processed_chunks",
            SESSION_TTL_SECONDS
        )

        print(f"[CALLBACK] Chunk {chunk_number} processed")
    except Exception as e:
        print(f"[CALLBACK] Error processing chunk {chunk_number}: {e}")


def assemble_video_async(session_id):
    session = get_session(session_id)

    if not session:
        return {"error": "Session not found"}

    filename = session["filename"]
    total_chunks = session["total_chunks"]
    temp_dir = Path(session["temp_dir"])

    final_path = UPLOAD_FOLDER / filename

    print(f"[ASYNC] Assembling {filename}")

    with open(final_path, "wb") as output_file:
        for i in range(total_chunks):
            chunk_file = temp_dir / f"chunk_{i}"

            if not chunk_file.exists():
                raise FileNotFoundError(f"Missing chunk {i}")

            with open(chunk_file, "rb") as chunk:
                while data := chunk.read(1024 * 1024):
                    output_file.write(data)

    session["assembled"] = True
    session["final_path"] = str(final_path)
    save_session(session_id, session)

    print(f"[ASYNC] Assembly complete: {final_path}")

    return {
        "status": "assembled",
        "session_id": session_id,
        "path": str(final_path),
        "size": final_path.stat().st_size
    }


def assembly_complete_callback(session_id, future):
    try:
        result = future.result()
        print(f"[CALLBACK] Assembly complete: {result}")
    except Exception as e:
        print(f"[CALLBACK] Assembly error: {e}")


@app.route("/api/upload/init", methods=["POST"])
def init_upload():
    data = request.get_json() or {}

    filename = secure_filename(data.get("filename", ""))
    file_size = int(data.get("file_size", 0))

    if not filename or file_size <= 0:
        return jsonify({"error": "Invalid filename or file size"}), 400

    session_id = uuid.uuid4().hex
    total_chunks = math.ceil(file_size / CHUNK_SIZE)

    temp_dir = UPLOAD_FOLDER / f"temp_{session_id}"
    temp_dir.mkdir(exist_ok=True)

    session_data = {
        "session_id": session_id,
        "filename": filename,
        "file_size": file_size,
        "chunk_size": CHUNK_SIZE,
        "total_chunks": total_chunks,
        "temp_dir": str(temp_dir),
        "assembly_started": False,
        "assembled": False,
    }

    save_session(session_id, session_data)

    return jsonify({
        "session_id": session_id,
        "chunk_size": CHUNK_SIZE,
        "total_chunks": total_chunks
    })


@app.route("/api/upload/chunk", methods=["POST"])
def upload_chunk():
    session_id = request.form.get("session_id")
    chunk_number = request.form.get("chunk", type=int)

    session = get_session(session_id)

    if not session:
        return jsonify({"error": "Invalid or expired session_id"}), 404

    if chunk_number is None:
        return jsonify({"error": "Missing chunk number"}), 400

    if chunk_number < 0 or chunk_number >= session["total_chunks"]:
        return jsonify({"error": "Invalid chunk number"}), 400

    if "file" not in request.files:
        return jsonify({"error": "Missing file chunk"}), 400

    uploaded_chunk = request.files["file"]

    temp_dir = Path(session["temp_dir"])
    chunk_file = temp_dir / f"chunk_{chunk_number}"

    uploaded_chunk.save(chunk_file)

    chunk_metadata = {
        "size": chunk_file.stat().st_size,
        "chunk_number": chunk_number,
        "timestamp": chunk_file.stat().st_ctime,
    }

    mark_chunk_received(session_id, chunk_number)

    future = executor.submit(
        process_chunk_async,
        session_id,
        chunk_number,
        chunk_file,
        chunk_metadata
    )

    future.add_done_callback(
        lambda f: chunk_processed_callback(session_id, chunk_number, f)
    )

    received_count = get_received_chunk_count(session_id)

    if (
        received_count == session["total_chunks"]
        and not session["assembly_started"]
    ):
        session["assembly_started"] = True
        save_session(session_id, session)

        assembly_future = executor.submit(assemble_video_async, session_id)

        assembly_future.add_done_callback(
            lambda f: assembly_complete_callback(session_id, f)
        )

        return jsonify({
            "status": "complete",
            "message": "All chunks received, assembly started",
            "session_id": session_id
        })

    return jsonify({
        "status": "uploading",
        "session_id": session_id,
        "chunk": chunk_number,
        "received_chunks": received_count,
        "total_chunks": session["total_chunks"]
    })


@app.route("/api/upload/status/<session_id>", methods=["GET"])
def upload_status(session_id):
    session = get_session(session_id)

    if not session:
        return jsonify({"error": "Invalid or expired session_id"}), 404

    processed_count = redis_client.scard(
        f"upload_session:{session_id}:processed_chunks"
    )

    return jsonify({
        "session_id": session_id,
        "filename": session["filename"],
        "total_chunks": session["total_chunks"],
        "received_chunks": get_received_chunks(session_id),
        "received_count": get_received_chunk_count(session_id),
        "processed_count": processed_count,
        "assembly_started": session["assembly_started"],
        "assembled": session["assembled"],
        "final_path": session.get("final_path")
    })


if __name__ == "__main__":
    app.run(
        debug=True,
        host="0.0.0.0",
        port=5000,
        threaded=True
    )