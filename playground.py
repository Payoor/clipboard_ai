from flask import Flask, request, jsonify
import os
import asyncio
import threading
from pathlib import Path
from werkzeug.utils import secure_filename
import hashlib
from concurrent.futures import ThreadPoolExecutor
import json

app = Flask(__name__)
UPLOAD_FOLDER = Path(__file__).parent / 'uploads'
UPLOAD_FOLDER.mkdir(exist_ok=True)

# Thread pool for async operations
executor = ThreadPoolExecutor(max_workers=4)

# Store upload sessions
upload_sessions = {}

class UploadSession:
    def __init__(self, filename, total_chunks, temp_dir):
        self.filename = filename
        self.total_chunks = total_chunks
        self.temp_dir = temp_dir
        self.received_chunks = set()
        self.chunk_data = {}  # Store metadata about each chunk
        self.processing_futures = []
        
    def add_chunk(self, chunk_num, chunk_path, metadata=None):
        self.received_chunks.add(chunk_num)
        self.chunk_data[chunk_num] = {
            'path': chunk_path,
            'metadata': metadata,
            'processed': False
        }

@app.route('/api/upload/chunk', methods=['POST'])
def upload_chunk():
    """Handle chunked upload with async processing on each chunk"""
    
    chunk_number = request.form.get('chunk', type=int)
    total_chunks = request.form.get('chunks', type=int)
    filename = secure_filename(request.form.get('filename'))
    session_id = request.form.get('session_id', hashlib.md5(f"{filename}_{chunk_number}".encode()).hexdigest())
    
    # Create or get upload session
    if session_id not in upload_sessions:
        temp_dir = UPLOAD_FOLDER / f'temp_{session_id}'
        temp_dir.mkdir(exist_ok=True)
        upload_sessions[session_id] = UploadSession(filename, total_chunks, temp_dir)
    
    session = upload_sessions[session_id]
    
    # Save the chunk
    chunk_file = session.temp_dir / f'chunk_{chunk_number}'
    uploaded_chunk = request.files['file']
    uploaded_chunk.save(chunk_file)
    
    # Collect metadata about the chunk
    chunk_metadata = {
        'size': chunk_file.stat().st_size,
        'chunk_number': chunk_number,
        'timestamp': chunk_file.stat().st_ctime
    }
    
    session.add_chunk(chunk_number, chunk_file, chunk_metadata)
    
    # START ASYNC OPERATIONS ON THIS CHUNK
    # Fire and forget - don't wait for completion
    future = executor.submit(
        process_chunk_async, 
        session_id, 
        chunk_number, 
        chunk_file, 
        chunk_metadata
    )
    
    session.processing_futures.append(future)
    
    # Optional: Add callback when chunk processing completes
    future.add_done_callback(lambda f: chunk_processed_callback(session_id, chunk_number, f))
    
    # If this is the last chunk, start assembly
    if chunk_number == total_chunks - 1:
        # Start async assembly (don't block response)
        assembly_future = executor.submit(assemble_video_async, session_id)
        assembly_future.add_done_callback(lambda f: assembly_complete_callback(session_id, f))
        
        return jsonify({
            'status': 'complete',
            'message': 'Last chunk received, assembly started',
            'session_id': session_id
        })
    
    return jsonify({
        'status': 'uploading',
        'chunk': chunk_number,
        'total_chunks': total_chunks,
        'session_id': session_id,
        'processing_started': True
    })

def process_chunk_async(session_id, chunk_number, chunk_file, metadata):
    """Async operations on individual chunks"""
    print(f"[ASYNC] Processing chunk {chunk_number} for session {session_id}")
    
    # Example operations for video editing app:
    
    # 1. Calculate chunk hash for integrity checking
    hash_md5 = hashlib.md5()
    with open(chunk_file, 'rb') as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)
    chunk_hash = hash_md5.hexdigest()
    
    # 2. Validate video chunk (check if it's valid MP4 data)
    is_valid = validate_chunk_headers(chunk_file)
    
    # 3. Extract metadata from chunk (first few bytes of video)
    video_info = extract_chunk_metadata(chunk_file)
    
    # 4. Scan for viruses/malware (simulated)
    # virus_scan(chunk_file)
    
    # 5. Generate thumbnail from first chunk (if it contains keyframe)
    if chunk_number == 0:
        thumbnail_path = generate_thumbnail_from_chunk(chunk_file)
    
    # 6. Compress or transcode chunk
    # compressed_path = compress_chunk(chunk_file)
    
    # 7. Store chunk metadata in database
    store_chunk_info(session_id, chunk_number, {
        'hash': chunk_hash,
        'valid': is_valid,
        'metadata': video_info,
        'size': chunk_file.stat().st_size
    })
    
    # 8. Upload chunk to cloud storage (S3, etc.)
    # upload_to_cloud(chunk_file, f"{session_id}/chunk_{chunk_number}")
    
    print(f"[ASYNC] Completed processing chunk {chunk_number}")
    return {
        'chunk': chunk_number,
        'hash': chunk_hash,
        'valid': is_valid,
        'metadata': video_info
    }

def assemble_video_async(session_id):
    """Assemble all chunks after upload complete"""
    session = upload_sessions.get(session_id)
    if not session:
        return {"error": "Session not found"}
    
    print(f"[ASYNC] Assembling video {session.filename} from {session.total_chunks} chunks")
    
    # Wait for all chunks to be processed (optional)
    # for future in session.processing_futures:
    #     future.result()  # Wait for completion
    
    final_path = UPLOAD_FOLDER / session.filename
    chunk_paths = []
    
    # Assemble chunks in order
    with open(final_path, 'wb') as output_file:
        for i in range(session.total_chunks):
            chunk_file = session.temp_dir / f'chunk_{i}'
            if chunk_file.exists():
                # Optional: Verify chunk hash before writing
                with open(chunk_file, 'rb') as chunk:
                    while data := chunk.read(1024 * 1024):
                        output_file.write(data)
                chunk_paths.append(chunk_file)
    
    # Final validation of assembled video
    final_hash = hash_file(final_path)
    final_size = final_path.stat().st_size
    
    # Store final video metadata
    store_video_metadata(session_id, {
        'filename': session.filename,
        'path': str(final_path),
        'size': final_size,
        'hash': final_hash,
        'chunks': session.total_chunks
    })
    
    # Cleanup temp files (async)
    cleanup_temp_files(session.temp_dir)
    
    return {
        'status': 'assembled',
        'filename': session.filename,
        'path': str(final_path),
        'size': final_size,
        'hash': final_hash
    }

def process_chunk_simultaneously(session_id, chunk_number, chunk_file):
    """Process multiple chunks in parallel"""
    
    # You can run multiple operations on the same chunk
    tasks = [
        ('extract_metadata', lambda: extract_video_metadata(chunk_file)),
        ('generate_thumbnail', lambda: create_thumbnail(chunk_file, chunk_number)),
        ('scan_content', lambda: content_analysis(chunk_file)),
        ('calculate_quality', lambda: quality_metrics(chunk_file))
    ]
    
    results = {}
    with ThreadPoolExecutor(max_workers=4) as chunk_executor:
        futures = {
            chunk_executor.submit(task_func): task_name 
            for task_name, task_func in tasks
        }
        
        for future in futures:
            task_name = futures[future]
            try:
                results[task_name] = future.result(timeout=30)
            except Exception as e:
                results[task_name] = {'error': str(e)}
    
    return results

# Helper functions for video processing
def validate_chunk_headers(chunk_file):
    """Check if chunk has valid video headers"""
    with open(chunk_file, 'rb') as f:
        header = f.read(100)  # Read first 100 bytes
        # Check for MP4 header (ftyp)
        return b'ftyp' in header or b'moov' in header

def extract_chunk_metadata(chunk_file):
    """Extract metadata from video chunk"""
    # In reality, you'd use libraries like ffmpeg
    with open(chunk_file, 'rb') as f:
        data = f.read(1024)
    return {
        'first_bytes': data[:50].hex(),
        'size': chunk_file.stat().st_size
    }

def generate_thumbnail_from_chunk(chunk_file):
    """Generate thumbnail from first chunk"""
    # Would use ffmpeg or similar in production
    thumbnail_path = chunk_file.parent / f"thumb_{chunk_file.name}.jpg"
    # ffmpeg -i chunk_file -ss 00:00:01 -vframes 1 thumbnail.jpg
    return str(thumbnail_path)

def hash_file(file_path):
    """Generate MD5 hash of file"""
    hash_md5 = hashlib.md5()
    with open(file_path, 'rb') as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()

def store_chunk_info(session_id, chunk_number, info):
    """Store chunk metadata in database"""
    # In production, use actual database
    print(f"[DB] Storing info for chunk {chunk_number}: {info}")

def store_video_metadata(session_id, metadata):
    """Store final video metadata"""
    print(f"[DB] Video metadata stored: {metadata}")

def cleanup_temp_files(temp_dir):
    """Clean up temporary files"""
    import shutil
    shutil.rmtree(temp_dir, ignore_errors=True)
    print(f"[CLEANUP] Removed {temp_dir}")

def chunk_processed_callback(session_id, chunk_number, future):
    """Callback when chunk processing completes"""
    try:
        result = future.result()
        print(f"[CALLBACK] Chunk {chunk_number} processed: {result}")
    except Exception as e:
        print(f"[CALLBACK] Error processing chunk {chunk_number}: {e}")

def assembly_complete_callback(session_id, future):
    """Callback when video assembly completes"""
    try:
        result = future.result()
        print(f"[CALLBACK] Assembly complete: {result}")
    except Exception as e:
        print(f"[CALLBACK] Assembly error: {e}")

# Additional useful endpoint
@app.route('/api/upload/status/<session_id>', methods=['GET'])
def upload_status(session_id):
    """Check status of upload and processing"""
    session = upload_sessions.get(session_id)
    if not session:
        return jsonify({'error': 'Session not found'}), 404
    
    # Check which futures are still running
    pending = [f for f in session.processing_futures if not f.done()]
    
    return jsonify({
        'session_id': session_id,
        'filename': session.filename,
        'total_chunks': session.total_chunks,
        'received_chunks': list(session.received_chunks),
        'chunks_processed': len([c for c in session.chunk_data.values() if c.get('processed')]),
        'chunks_remaining': len(pending),
        'assembly_complete': hasattr(session, 'assembled')
    })

if __name__ == '__main__':
    print("Server with per-chunk async processing running on http://localhost:5000")
    app.run(debug=True, host='0.0.0.0', port=5000, threaded=True) 