-- Run this script in the Supabase SQL Editor to create your tables

-- Create Users Table
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL
);

-- Create Tests Table
CREATE TABLE IF NOT EXISTS public.tests (
    id UUID PRIMARY KEY,
    title TEXT NOT NULL,
    subject TEXT,
    description TEXT,
    duration INTEGER,
    "totalMarks" INTEGER,
    "scheduledAt" TEXT,
    "createdBy" UUID REFERENCES public.users(id) ON DELETE CASCADE
);

-- Insert Seed Users
INSERT INTO public.users (id, name, email, password, role)
VALUES 
    -- The password hashes are generated using Werkzeug's default pbkdf2:sha256 for 'student123' and 'proctor123'
    ('11111111-1111-1111-1111-111111111111', 'Rohit Singh', 'rohit@gmail.com', 'scrypt:32768:8:1$xNXY2hA0N0Jq3N2E$9c8942b918a2253edce6c507a2d3b259160d2b70f065d63f2d2b51201103f7e025b6a3cc4eb360eb11a3b4e60b240fc40e53e41d8e132c32cf9768393e9e1c31', 'student'),
    ('22222222-2222-2222-2222-222222222222', 'Dr. Kumar', 'proctor@gmail.com', 'scrypt:32768:8:1$a0hB2lP1QkM1O3H$2e931458e658bc66f578762740fc060d4029202164478201509a25b3eb38127fbcf7429107ccbc59b58e727500b1a0300fc5d4f3b793393db4c80356598c4d28', 'proctor');
