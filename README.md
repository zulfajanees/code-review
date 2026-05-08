# AI Code Review Web App

A simple web app that lets you paste code and receive AI-powered review feedback.

## Features

- Paste code and request focused reviews (security, performance, readability, etc.)
- Add optional author notes and language hints
- Receive structured markdown feedback with suggested improvements
- Lightweight stack: Node.js backend + static frontend

## Setup

1. Create a `.env` file from `.env.example`:

   ```bash
   copy .env.example .env
   ```

2. Set your Gemini API key in `.env`:

   ```env
   GEMINI_API_KEY=your_api_key_here
   GEMINI_MODEL=gemini-2.0-flash-lite
   PORT=3000
   ```

   For Vercel deployment, set `GEMINI_API_KEY` and optional `GEMINI_MODEL` in Project Settings -> Environment Variables.

3. Run the app:

   ```bash
   node server.js
   ```

4. Open [http://localhost:3000](http://localhost:3000).

## API

### `POST /api/review`

Request body:

```json
{
  "code": "function add(a,b){return a+b}",
  "language": "JavaScript",
  "focus": "security, readability",
  "notes": "This is from a utility module."
}
```

Response:

```json
{
  "review": {
    "overview": "...",
    "suggestions": "...",
    "explanation": "...",
    "score": 82,
    "subscores": {
      "correctness": 84,
      "security": 78,
      "maintainability": 85
    },
    "issues": []
  }
}
