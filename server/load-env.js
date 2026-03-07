// Load environment variables from .env before other imports execute.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Try .env first, then .env.development.local as fallback.
// Both are optional — silence errors when neither exists.
const envCandidates = [
  path.join(__dirname, '../.env'),
  path.join(__dirname, '../.env.development.local'),
];

for (const envPath of envCandidates) {
  try {
    const envFile = fs.readFileSync(envPath, 'utf8');
    envFile.split('\n').forEach(line => {
      const trimmedLine = line.trim();
      if (trimmedLine && !trimmedLine.startsWith('#')) {
        const [key, ...valueParts] = trimmedLine.split('=');
        if (key && valueParts.length > 0 && !process.env[key]) {
          process.env[key] = valueParts.join('=').trim();
        }
      }
    });
    break; // loaded successfully, stop trying
  } catch {
    // file not found, try next candidate
  }
}
