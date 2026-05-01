-- Run this in the Supabase SQL Editor to enable cross-device proctoring
CREATE TABLE IF NOT EXISTS public.live_sessions (
    student_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    name TEXT,
    email TEXT,
    exam_title TEXT,
    subject TEXT,
    status TEXT, -- 'active', 'completed', 'exited'
    progress INTEGER,
    answered INTEGER,
    total INTEGER,
    current_q INTEGER,
    violations INTEGER,
    face_status TEXT,
    face_message TEXT,
    time_left INTEGER,
    last_frame TEXT, -- Stores the Base64 webcam frame
    warning_message TEXT, -- Real-time message from proctor
    last_heartbeat TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS (Optional, but recommended)
ALTER TABLE public.live_sessions ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read/write for now (simplest for testing)
CREATE POLICY "Allow public read" ON public.live_sessions FOR SELECT USING (true);
CREATE POLICY "Allow public insert" ON public.live_sessions FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update" ON public.live_sessions FOR UPDATE USING (true);
