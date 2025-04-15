import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fsPromises from 'fs/promises'; // Use promises API for async file operations
import fs from 'fs'; // Use standard fs for sync operations
import multer from 'multer';

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Enable CORS for all origins (adjust for production)
app.use(express.json()); // Parse JSON request bodies (for transcription)
// Note: We don't need express.urlencoded() unless sending form data that isn't multipart

// Multer configuration (store in memory for this example)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Ensure recordings directory exists (synchronous check on startup is acceptable)
const recordingsDir = path.join(__dirname, '../recordings'); // Path relative to dist/server.js
if (!fs.existsSync(recordingsDir)) {
    console.log(`Creating recordings directory: ${recordingsDir}`);
    fs.mkdirSync(recordingsDir, { recursive: true });
}

// --- Interview Data (In-memory placeholder) ---
// In a real application, this would come from a database
interface InterviewSession {
    code: string;
    systemPromptPath: string; // Path to the system prompt file
    config: {
        endpoint: string;
        apiKey: string;
        deployment: string;
        voice: string; // e.g., "coral"
        temperature?: number;
    };
    // Add other relevant data: candidate name, job role, expiry, etc.
}

// Placeholder: Store valid interview codes and their associated prompts
// We'll use the interviewerSystemPrompt.md provided earlier
const validInterviews: { [code: string]: InterviewSession } = {
    "ANS459": { // Example code
        code: "ANS459",
        // Correct path relative to the *project root* after deployment (file is now inside UniqPick4)
        systemPromptPath: path.join(__dirname, '../../interviewerSystemPrompt.md'), // Path from /var/www/uniqpick4/backend/dist/ up 2 levels to project root
        config: {
            endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
            apiKey: process.env.AZURE_OPENAI_KEY!,
            deployment: process.env.AZURE_OPENAI_DEPLOYMENT!,
            voice: "coral", // As requested
            // temperature: 0.8 // Optional: set a default if needed
        }
    }
    // Add more codes as needed
};

// --- API Routes ---

// Endpoint to validate interview code and get configuration
// Match the path passed by Nginx proxy (without /api/)
app.get('/interview/:code/config', async (req: Request, res: Response): Promise<void> => {
    const { code } = req.params;
    const interview = validInterviews[code];

    if (!interview) {
        res.status(404).json({ message: 'Invalid interview code.' });
        return; // Add explicit return
    }

    try {
        // Read the system prompt content
        const systemPromptContent = await fsPromises.readFile(interview.systemPromptPath, 'utf-8'); // Use fsPromises

        // Return the configuration needed by the frontend
        res.json({
            ...interview.config,
            systemPrompt: systemPromptContent // Add the actual prompt content
        });
        return; // Add explicit return

    } catch (error) {
        console.error(`Error reading system prompt for code ${code}:`, error);
        res.status(500).json({ message: 'Error retrieving interview configuration.' });
        return; // Add explicit return
    }
});

// Endpoint to receive recording and transcription upon completion
// Match the path passed by Nginx proxy (without /api/)
app.post('/interview/:code/complete', upload.single('recording'), async (req: Request, res: Response): Promise<void> => {
    const { code } = req.params;
    const { transcription } = req.body;
    const recordingFile = req.file;

    // --- Add Logging ---
    console.log(`Received request for /complete with code: "${code}"`);
    const interviewExists = !!validInterviews[code];
    console.log(`Interview code "${code}" exists in validInterviews: ${interviewExists}`);
    // --- End Logging ---

    if (!validInterviews[code]) {
        res.status(404).json({ message: 'Invalid interview code.' });
        return;
    }

    if (!recordingFile) {
        res.status(400).json({ message: 'No recording file uploaded.' });
        return;
    }

    if (!transcription || typeof transcription !== 'string') {
        res.status(400).json({ message: 'Transcription data missing or invalid.' });
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const recordingFilename = `${code}-${timestamp}.webm`; // Assuming webm format from frontend
    const transcriptionFilename = `${code}-${timestamp}.txt`;
    const recordingPath = path.join(recordingsDir, recordingFilename);
    const transcriptionPath = path.join(recordingsDir, transcriptionFilename);

    try {
        // Save recording buffer to file
        await fsPromises.writeFile(recordingPath, recordingFile.buffer); // Use fsPromises
        console.log(`Recording saved: ${recordingPath}`);

        // Save transcription to file
        await fsPromises.writeFile(transcriptionPath, transcription); // Use fsPromises
        console.log(`Transcription saved: ${transcriptionPath}`);

        res.status(200).json({ message: 'Interview data saved successfully.' });
        return;

    } catch (error) {
        console.error(`Error saving interview data for code ${code}:`, error);
        res.status(500).json({ message: 'Error saving interview data.' });
        return;
    }
});

// --- Start Server ---
app.listen(port, () => {
    console.log(`UniqPick4 backend server listening on port ${port}`);
    // Verify environment variables are loaded
    if (!process.env.AZURE_OPENAI_ENDPOINT || !process.env.AZURE_OPENAI_KEY || !process.env.AZURE_OPENAI_DEPLOYMENT) {
        console.warn("WARN: Azure OpenAI environment variables (ENDPOINT, KEY, DEPLOYMENT) are not fully set in .env");
    }
     // Removed prompt file check on startup for debugging
});
