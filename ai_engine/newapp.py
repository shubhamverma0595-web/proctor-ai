import os
import json
import uuid
import base64
import requests
import cv2
import numpy as np
import datetime

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
from dotenv import load_dotenv
from supabase import create_client, Client

# Load environment variables
print("Starting app...")
load_dotenv(override=True)
print("Env variables loaded.")

OPENROUTER_KEY = os.getenv("OPENROUTER_KEY")
print("OPENROUTER_KEY:", OPENROUTER_KEY)

# ---------------- CONFIG ----------------
class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "mysecret")

# ---------------- APP INIT ----------------
app = Flask(__name__)
app.config.from_object(Config)
CORS(app)

# ---------------- SUPABASE INIT ----------------
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")

# We only create the client if the URL and KEY are present. 
# Otherwise, API calls will fail, which is expected since you need the DB.
supabase: Client = None
if SUPABASE_URL and SUPABASE_KEY:
    print("Connecting to Supabase...")
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    print("Supabase connected.")
else:
    print("WARNING: SUPABASE_URL or SUPABASE_KEY is missing from .env")

# ---------------- MEDIAPIPE INIT (GLOBAL) ----------------
# ---------------- MEDIAPIPE INIT (GLOBAL) ----------------
detector = None

def get_face_detector():
    global detector
    if detector is None:
        try:
            print("Lazy initializing Mediapipe...")
            import mediapipe as mp
            import mediapipe.python.solutions.face_detection as mp_face
            detector = mp_face.FaceDetection(model_selection=0, min_detection_confidence=0.5)
            print("Mediapipe initialized successfully.")
        except Exception as e:
            print(f"FAILED to initialize Mediapipe: {e}")
            # Fallback or error handling
    return detector


# ---------------- ROUTES ----------------

@app.route("/health")
def health():
    return jsonify({"status": "ok", "supabase": supabase is not None})


# -------- LOGIN --------
@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json()

    email = data.get("email", "").lower().strip()
    password = data.get("password")
    role = data.get("role")  # optional

    if not email or not password:
        return jsonify({"error": "Missing fields"}), 400

    try:
        response = supabase.table('users').select('*').ilike('email', email).execute()
        if not response.data:
            return jsonify({"error": "User not found"}), 401
        
        user = response.data[0]
        
        if not check_password_hash(user["password"], password):
            return jsonify({"error": "Invalid password"}), 401

        # Safe role check
        if role and user["role"] != role:
            return jsonify({
                "error": f"Login as {user['role']} instead"
            }), 400

        return jsonify({
            "status": "success",
            "user": {
                "id": user["id"],
                "name": user["name"],
                "email": user["email"],
                "role": user["role"]
            }
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# -------- REGISTER --------
@app.route("/api/register", methods=["POST"])
def register():
    try:
        data = request.get_json()

        name = data.get("name")
        email = data.get("email", "").lower().strip()
        password = data.get("password")

        if not email or not password or not name:
            return jsonify({"error": "Missing fields"}), 400

        exists = supabase.table('users').select('id').ilike('email', email).execute()
        if exists.data:
            return jsonify({"error": "Email already registered"}), 400

        supabase.table('users').insert({
            "id": str(uuid.uuid4()),
            "name": name,
            "email": email,
            "password": generate_password_hash(password),
            "role": "student"
        }).execute()

        return jsonify({"status": "success"})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# -------- AI FACE ANALYSIS --------
@app.route("/api/analyze", methods=["POST"])
def analyze():
    data = request.get_json()

    if not data or "image" not in data:
        return jsonify({"error": "No image provided"}), 400

    try:
        image_data = data["image"]

        if "," in image_data:
            image_data = image_data.split(",")[1]

        img_bytes = base64.b64decode(image_data)
        np_arr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        if img is None:
            return jsonify({"error": "Invalid image"}), 400

        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        
        face_detector = get_face_detector()
        if face_detector is None:
             return jsonify({"error": "AI Engine (Mediapipe) failed to load on server"}), 500
             
        result = face_detector.process(rgb)

        face_count = len(result.detections) if result and result.detections else 0

        violations = []
        if face_count == 0:
            violations.append("face_not_visible")
        elif face_count > 1:
            violations.append("multiple_faces")

        return jsonify({
            "face_count": face_count,
            "face_visible": face_count > 0,
            "multiple_faces": face_count > 1,
            "violations": violations
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# -------- AI QUESTION GENERATOR --------
@app.route('/api/questions', methods=['POST'])
def generate_questions():
    if not OPENROUTER_KEY:
        return jsonify({"error": "Missing API key"}), 500

    data = request.get_json()

    payload = {
        "model": "openai/gpt-4o-mini",
        "messages": data.get("messages", [
            {"role": "user", "content": "Generate 5 MCQs with answers"}
        ])
    }

    try:
        resp = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_KEY}",
                "Content-Type": "application/json"
            },
            json=payload,
            timeout=15  # Add timeout to prevent hanging
        )
        resp.raise_for_status()
        return jsonify(resp.json()), resp.status_code

    except Exception as e:
        print(f"Error generating questions: {e}")
        return jsonify({"error": str(e)}), 500


# -------- TEST MANAGEMENT --------
@app.route("/api/tests", methods=["POST"])
def create_test():
    data = request.get_json()

    if not data or not data.get("title"):
        return jsonify({"error": "Title required"}), 400

    try:
        supabase.table('tests').insert({
            "id": str(uuid.uuid4()),
            "title": data.get("title"),
            "subject": data.get("subject"),
            "description": data.get("description"),
            "duration": data.get("duration"),
            "totalMarks": data.get("totalMarks"),
            "scheduledAt": data.get("scheduledAt"),
            "createdBy": data.get("createdBy")
        }).execute()

        return jsonify({"status": "test created"})
    except Exception as e:
         return jsonify({"error": str(e)}), 500


# -------- GET ALL STUDENTS --------
@app.route("/api/users", methods=["GET"])
def get_users():
    try:
        response = supabase.table('users').select('id, name, email').eq('role', 'student').execute()
        return jsonify(response.data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/tests", methods=["GET"])
def get_tests():
    try:
        response = supabase.table('tests').select('*').execute()
        return jsonify(response.data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/tests/<test_id>", methods=["DELETE"])
def delete_test(test_id):
    try:
        test = supabase.table('tests').select('id').eq('id', test_id).execute()
        if not test.data:
            return jsonify({"error": "Test not found"}), 404

        supabase.table('tests').delete().eq('id', test_id).execute()
        return jsonify({"status": "test deleted"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# -------- PROCTORING SYNC --------

@app.route("/api/proctor/update", methods=["POST"])
def update_proctor_session():
    data = request.get_json()
    if not data or not data.get("studentId"):
        return jsonify({"error": "Missing studentId"}), 400
    
    try:
        # Map frontend camelCase to backend snake_case for Supabase
        session_data = {
            "student_id": data.get("studentId"),
            "name": data.get("name"),
            "email": data.get("email"),
            "exam_title": data.get("examTitle"),
            "subject": data.get("subject"),
            "status": data.get("status"),
            "progress": data.get("progress"),
            "answered": data.get("answered"),
            "total": data.get("total"),
            "current_q": data.get("currentQ"),
            "violations": data.get("violations"),
            "face_status": data.get("faceStatus"),
            "face_message": data.get("faceMessage"),
            "time_left": data.get("timeLeft"),
            "last_frame": data.get("lastFrame"),
            "last_heartbeat": datetime.datetime.utcnow().isoformat()
        }
        
        # Upsert into live_sessions
        supabase.table('live_sessions').upsert(session_data).execute()
        
        # Check if there's a pending warning to return to the student
        session_check = supabase.table('live_sessions').select('warning_message').eq('student_id', session_data['student_id']).execute()
        warning = None
        if session_check.data and session_check.data[0].get('warning_message'):
            warning = session_check.data[0]['warning_message']
            
        return jsonify({"status": "success", "warning": warning}), 200
    except Exception as e:
        print(f"Error in proctor update: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/proctor/sessions", methods=["GET"])
def get_proctor_sessions():
    try:
        # Fetch all live sessions
        response = supabase.table('live_sessions').select('*').execute()
        return jsonify(response.data)
    except Exception as e:
        print(f"Error fetching sessions: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/proctor/warn", methods=["POST"])
def warn_student():
    data = request.get_json()
    student_id = data.get("studentId")
    message = data.get("message")
    
    if not student_id or not message:
        return jsonify({"error": "Missing studentId or message"}), 400
        
    try:
        supabase.table('live_sessions').update({"warning_message": message}).eq('student_id', student_id).execute()
        return jsonify({"status": "success"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/proctor/clear_warning", methods=["POST"])
def clear_warning():
    data = request.get_json()
    student_id = data.get("studentId")
    
    if not student_id:
        return jsonify({"error": "Missing studentId"}), 400
        
    try:
        supabase.table('live_sessions').update({"warning_message": None}).eq('student_id', student_id).execute()
        return jsonify({"status": "success"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# -------- FRONTEND SERVE --------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# go OUT of ai_engine → then into html-frontend
FRONTEND_DIR = os.path.join(BASE_DIR,'..', "html-frontend")

@app.route("/", defaults={"path": "login.html"})
@app.route("/<path:path>")
def frontend(path):
    return send_from_directory(FRONTEND_DIR, path)

# ---------------- RUN ----------------
if __name__ == "__main__":
    app.run(debug=True, port=5000)