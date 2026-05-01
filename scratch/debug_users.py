import os
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv(override=True)

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("SUPABASE_URL or SUPABASE_KEY missing")
    exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

try:
    response = supabase.table('users').select('*').execute()
    print("Users in database:")
    for user in response.data:
        print(f"ID: {user['id']}, Name: {user['name']}, Email: '{user['email']}', Role: {user['role']}")
except Exception as e:
    print(f"Error: {e}")
