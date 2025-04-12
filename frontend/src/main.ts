// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Player } from "./player.ts";
import { Recorder } from "./recorder.ts";
import "./style.css";
import { LowLevelRTClient, SessionUpdateMessage, Voice } from "rt-client"; // Removed SessionConfig import

let realtimeStreaming: LowLevelRTClient | undefined; // Allow undefined
let audioContext: AudioContext | null = null; // Shared AudioContext
let audioRecorder: Recorder;
let audioPlayer: Player;
let mixedAudioDestination: MediaStreamAudioDestinationNode | null = null; // For capturing mixed audio

// Interface for configuration fetched from backend
interface InterviewConfig {
    code: string; // Add interview code
    endpoint: string;
    apiKey: string;
    deployment: string;
    systemPrompt: string;
    voice: Voice;
    temperature?: number; // Optional
}

// Modified to accept a config object
async function start_realtime(config: InterviewConfig) {
    // Assuming Azure OpenAI for now based on user prompt
    realtimeStreaming = new LowLevelRTClient(new URL(config.endpoint), { key: config.apiKey }, { deployment: config.deployment });

  try {
    console.log("sending session config");
    await realtimeStreaming.send(createConfigMessage(config)); // Pass config
  } catch (error) {
    console.log(error);
    addSystemMessage("[Connection error]: Unable to send initial config message. Please check your endpoint and authentication details.");
    setUIState(UIState.InterviewReady); // Update state
    return;
  }
  console.log("sent");
  // Permissions are requested earlier now
  await handleRealtimeMessages();
}

// Modified to use the passed config object
function createConfigMessage(config: InterviewConfig): SessionUpdateMessage {
    // Define the session config structure directly based on SessionUpdateMessage
    const sessionConfig: SessionUpdateMessage['session'] = {
        turn_detection: {
            type: "server_vad",
        },
        input_audio_transcription: {
            model: "whisper-1" // Or make configurable if needed
        },
        instructions: config.systemPrompt,
        voice: config.voice,
    };

    if (config.temperature !== undefined && !isNaN(config.temperature)) {
        sessionConfig.temperature = config.temperature;
    }

    const configMessage: SessionUpdateMessage = {
        type: "session.update",
        session: sessionConfig
    };

    return configMessage;
}

async function handleRealtimeMessages() {
  if (!realtimeStreaming) {
      console.error("handleRealtimeMessages called but realtimeStreaming is undefined.");
      return;
  }
  for await (const message of realtimeStreaming.messages()) {
    let consoleLog = "" + message.type;

    switch (message.type) {
      case "session.created":
        setUIState(UIState.InterviewInProgress);
        startTimer(15 * 60); // Start 15 min timer
        addSystemMessage("<< Session Started >>");
        break;
      case "response.audio_transcript.delta":
        appendToTextBlock(message.delta);
        break;
      case "response.audio.delta":
        const binary = atob(message.delta);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const pcmData = new Int16Array(bytes.buffer);
        audioPlayer.play(pcmData);
        break;

      case "input_audio_buffer.speech_started":
        // We don't need a separate block for "Speech Started" with the new styling
        // latestInputSpeechBlock logic is replaced by addTranscriptionMessage('User: ...')
        audioPlayer.clear();
        break;
      case "conversation.item.input_audio_transcription.completed":
        addTranscriptionMessage(message.transcript, 'user');
        break;
      case "response.done":
        // Maybe add a visual separator or just rely on message blocks
        // transcriptionContainer.querySelector('#received-text-container')?.appendChild(document.createElement("hr"));
        break;
      default:
        consoleLog = JSON.stringify(message, null, 2);
        break
    }
    if (consoleLog) {
      console.log(consoleLog);
    }
  }
  stopInterviewCleanup(); // Call new cleanup function
}

/**
 * Basic audio handling
 */

let recordingActive: boolean = false;
let buffer: Uint8Array = new Uint8Array();

function combineArray(newData: Uint8Array) {
  const newBuffer = new Uint8Array(buffer.length + newData.length);
  newBuffer.set(buffer);
  newBuffer.set(newData, buffer.length);
  buffer = newBuffer;
}

function processAudioRecordingBuffer(data: Buffer) {
  const uint8Array = new Uint8Array(data);
  combineArray(uint8Array);
  if (buffer.length >= 4800) {
    const toSend = new Uint8Array(buffer.slice(0, 4800));
    buffer = new Uint8Array(buffer.slice(4800));
    const regularArray = String.fromCharCode(...toSend);
    const base64 = btoa(regularArray);
    if (recordingActive) {
      if (realtimeStreaming) { // Add check here too
          realtimeStreaming.send({
              type: "input_audio_buffer.append",
              audio: base64,
          });
      }
    }
  }

}

let userMediaStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];

// Renamed and modified to handle permissions and stream setup
async function requestPermissionsAndSetupMedia(): Promise<boolean> {
    try {
        userMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });

        // --- Create Shared AudioContext ---
        // Use a standard sample rate if possible, or let the browser choose. 24000 might be specific to the SDK output.
        // Let's stick with 24000 for now as the Player/Recorder expect it.
        audioContext = new AudioContext({ sampleRate: 24000 });
        mixedAudioDestination = audioContext.createMediaStreamDestination(); // Create destination for mixed stream

        // --- Setup Audio Player (Needs context) ---
        audioPlayer = new Player();
        // Pass context and the destination for the AI voice audio
        await audioPlayer.init(audioContext, mixedAudioDestination);

        // --- Setup Audio Recorder (Needs context and stream source) ---
        const microphoneSourceNode = audioContext.createMediaStreamSource(userMediaStream);
        audioRecorder = new Recorder(processAudioRecordingBuffer);
        // Pass context and the source node for the microphone audio
        await audioRecorder.start(audioContext, microphoneSourceNode, mixedAudioDestination);

        // --- Setup Video Display ---
        if (userVideoElement) {
            // Display original stream (video only needed)
            userVideoElement.srcObject = userMediaStream;
            userVideoElement.play().catch(e => console.error("Video play error:", e));
        } else {
            console.error("User video element not found!");
        }

        recordingActive = true; // Mark recording as potentially active (MediaRecorder setup follows)

        // --- Setup MediaRecorder ---
        // --- Setup MediaRecorder with MIXED audio and original video ---
        if (mixedAudioDestination && userMediaStream.getVideoTracks().length > 0) {
            const mixedAudioTrack = mixedAudioDestination.stream.getAudioTracks()[0];
            const videoTrack = userMediaStream.getVideoTracks()[0];
            const combinedStream = new MediaStream([mixedAudioTrack, videoTrack]);

            try {
                const options = { mimeType: 'video/webm;codecs=vp8,opus' }; // Keep preferred format
                if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                    console.warn(`${options.mimeType} not supported, trying default`);
                    mediaRecorder = new MediaRecorder(combinedStream);
                } else {
                    mediaRecorder = new MediaRecorder(combinedStream, options);
                }

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    recordedChunks.push(event.data);
                    console.log("Recorded chunk size:", event.data.size);
                }
            };

            mediaRecorder.onstop = () => {
                console.log("MediaRecorder stopped.");
                // Create blob and trigger upload *after* recorder stops fully
                const recordingBlob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || 'video/webm' });
                const fullTranscription = getFullTranscription();
                uploadInterviewData(recordingBlob, fullTranscription);
                recordedChunks = []; // Clear chunks for next potential recording
            };

            mediaRecorder.start(); // Start recording the combined stream
            console.log("MediaRecorder started with state:", mediaRecorder.state);

        } catch (recorderError) {
             console.error("Error setting up MediaRecorder:", recorderError);
             // Handle this error - maybe alert user, disable recording upload?
             alert("Could not start video recording.");
             // Proceed without recording? Or stop the interview setup?
             // For now, we'll let the interview proceed without recording upload capability
                 mediaRecorder = null;
            }
        } else {
             console.error("Cannot setup MediaRecorder: Missing mixed audio destination or video track.");
             alert("Could not initialize recording components.");
             mediaRecorder = null;
             // Decide how to handle this - stop interview?
        }
        return true;
    } catch (error) {
        console.error("Error getting user media:", error);
        alert("Failed to access microphone and webcam. Please check permissions.");
        // Handle UI state, maybe show an error message on the join screen
        joinErrorElement.textContent = "Microphone and Webcam access denied. Please allow access and refresh.";
        joinErrorElement.style.display = 'block';
        setUIState(UIState.JoinScreen); // Go back to join screen or an error state
        return false;
    }
}

// Function to stop recording and release media
function stopMediaAndRecording() {
    // Stop MediaRecorder first if it's running
    if (mediaRecorder && mediaRecorder.state === "recording") {
        console.log("Stopping MediaRecorder...");
        mediaRecorder.stop(); // This will trigger the onstop handler for upload
    } else {
         // If recorder wasn't running or already stopped, clear chunks
         recordedChunks = [];
    }

    recordingActive = false; // Mark as inactive

    // Stop the custom audio recorder (for sending to Azure)
    if (audioRecorder) {
        audioRecorder.stop();
    }
    // Clear player buffer
    if (audioPlayer) {
        audioPlayer.clear();
    }
    // Close the shared AudioContext only when completely stopping
    // if (audioContext && audioContext.state !== 'closed') {
    //     audioContext.close();
    //     audioContext = null;
    // }
    if (userMediaStream) {
        userMediaStream.getTracks().forEach(track => track.stop());
        userMediaStream = null;
    }
    if (userVideoElement) {
        userVideoElement.srcObject = null;
    }
}

// Cleanup function called when stopping or closing
// Modified to handle MediaRecorder stopping and potential upload delay
async function stopInterviewCleanup() {
    stopTimer();

    // Close Azure connection first
    if (realtimeStreaming) {
         realtimeStreaming.close();
         realtimeStreaming = undefined;
    }
    // Close the shared AudioContext here when interview fully ends
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().then(() => console.log("Shared AudioContext closed."));
        audioContext = null;
    }

    // Stop media streams and recorders
    // Note: mediaRecorder.stop() is now called within stopMediaAndRecording
    // and the upload happens in its onstop handler.
    stopMediaAndRecording();

    // Update UI immediately
    // Update UI state first to show the End Screen
    setUIState(UIState.InterviewEnded);
    // Set initial message on End Screen
    updateEndScreenMessage("Interview Ended. Processing recording...");
    // The actual upload confirmation/error will be handled in uploadInterviewData
}

// --- Function to get full transcription text ---
function getFullTranscription(): string {
    let fullText = "";
    const textElements = transcriptionContainer.querySelectorAll('p, hr'); // Get all paragraphs and horizontal rules
    textElements.forEach(el => {
        if (el.tagName === 'P') {
            fullText += el.textContent + "\n";
        } else if (el.tagName === 'HR') {
            fullText += "--------------------\n"; // Represent HRs
        }
    });
    return fullText.trim();
}


// --- Function to upload recording and transcription ---
async function uploadInterviewData(recordingBlob: Blob, transcription: string) {
    if (!currentInterviewConfig) {
        console.error("Cannot upload data: Interview config is missing.");
        updateEndScreenMessage("Failed to upload recording: Configuration missing.", true);
        return;
    }
    if (recordingBlob.size === 0) {
        console.warn("Skipping upload: Recording blob is empty.");
         updateEndScreenMessage("Warning: No recording data captured to upload.");
        return;
    }

    console.log(`Uploading recording (${(recordingBlob.size / 1024 / 1024).toFixed(2)} MB) and transcription...`);
    // Message already set in stopInterviewCleanup, update upon result


    const formData = new FormData();
    formData.append('recording', recordingBlob, `${currentInterviewConfig.code}-recording.webm`); // Provide a filename
    formData.append('transcription', transcription);

    const uploadUrl = `http://localhost:3000/api/interview/${currentInterviewConfig.code}/complete`;

    // --- Add Frontend Logging ---
    console.log("Attempting upload to URL:", uploadUrl);
    console.log("Using interview config for upload:", JSON.stringify(currentInterviewConfig));
    // --- End Frontend Logging ---

    try {
        const response = await fetch(uploadUrl, {
            method: 'POST',
            body: formData,
            // Headers are automatically set by fetch for FormData
        });

        if (response.ok) {
            const result = await response.json();
            console.log("Upload successful:", result);
            updateEndScreenMessage("Interview data uploaded successfully.");
        } else {
            const errorData = await response.json().catch(() => ({ message: 'Unknown upload error' }));
            console.error(`Upload failed: ${response.status}`, errorData);
            updateEndScreenMessage(`Failed to upload interview data: ${errorData.message || response.statusText}`, true);
        }
    } catch (error) {
        console.error("Error during upload fetch:", error);
        updateEndScreenMessage("Network error during upload.", true);
    }
}

/**
 * UI and controls
 */

// --- New UI Element References ---
const joinScreenElement = document.querySelector<HTMLDivElement>("#join-screen")!;
const interviewScreenElement = document.querySelector<HTMLDivElement>("#interview-screen")!;
const endScreenElement = document.querySelector<HTMLDivElement>("#end-screen")!; // Add End Screen
const endMessageElement = document.querySelector<HTMLParagraphElement>("#end-message")!; // Add End Screen Message
const interviewCodeInputElement = document.querySelector<HTMLInputElement>("#interview-code")!;
const joinButtonElement = document.querySelector<HTMLButtonElement>("#join-button")!;
const joinErrorElement = document.querySelector<HTMLParagraphElement>("#join-error")!;
const timerElement = document.querySelector<HTMLSpanElement>("#timer")!;
const userVideoElement = document.querySelector<HTMLVideoElement>("#user-video")!;
const startInterviewButton = document.querySelector<HTMLButtonElement>("#start-interview")!;
const stopInterviewButton = document.querySelector<HTMLButtonElement>("#stop-interview")!;
const transcriptionContainer = document.querySelector<HTMLDivElement>("#transcription-container")!; // Target the container div itself

let latestInputSpeechBlock: Element;

// --- New UI State Enum ---
enum UIState {
    JoinScreen,
    ValidatingCode,
    RequestingPermissions,
    InterviewReady, // Permissions granted, ready to start session
    Connecting, // Connecting to Azure
    InterviewInProgress,
    InterviewEnded,
    Error,
}

// Removed isAzureOpenAI and guessIfIsAzureOpenAI

// --- Updated State Management Function ---
function setUIState(state: UIState) {
    // --- Handle Screen Visibility (Simplified) ---
    const isJoinVisible = (state === UIState.JoinScreen || state === UIState.ValidatingCode || state === UIState.Error);
    const isInterviewVisible = (state === UIState.RequestingPermissions || state === UIState.InterviewReady || state === UIState.Connecting || state === UIState.InterviewInProgress);
    const isEndVisible = (state === UIState.InterviewEnded);

    joinScreenElement.classList.toggle('hidden', !isJoinVisible);
    interviewScreenElement.classList.toggle('hidden', !isInterviewVisible);
    endScreenElement.classList.toggle('hidden', !isEndVisible);
    // --- End Screen Visibility Handling ---

    // Enable/disable buttons
    joinButtonElement.disabled = state !== UIState.JoinScreen;
    startInterviewButton.disabled = state !== UIState.InterviewReady;
    stopInterviewButton.disabled = state !== UIState.InterviewInProgress;

    // Show/hide error message
    joinErrorElement.style.display = state === UIState.Error ? 'block' : 'none';

    // Potentially update button text or add loading indicators
    if (state === UIState.ValidatingCode) {
        joinButtonElement.textContent = "Validating...";
    } else {
        joinButtonElement.textContent = "Join";
    }
     if (state === UIState.Connecting) {
        startInterviewButton.textContent = "Connecting...";
    } else {
        startInterviewButton.textContent = "Start Interview";
    }

     // Handle specific error messages if needed
     if (state !== UIState.Error) {
         joinErrorElement.textContent = ""; // Clear previous errors
     }
}

// Removed getSystemMessage, getTemperature, getVoice

// Function to add messages to the transcription container
function addTranscriptionMessage(text: string, type: 'ai' | 'user' | 'system') {
    const container = transcriptionContainer.querySelector('#received-text-container'); // Target inner div
    if (!container) return;

    const p = document.createElement("p");
    p.classList.add('p-2', 'rounded-lg', 'mb-2'); // Add margin-bottom

    let strong = document.createElement("strong");
    strong.classList.add('font-semibold');

    if (type === 'ai') {
        p.classList.add('bg-blue-50');
        strong.classList.add('text-brand-primary');
        strong.textContent = "AI: ";
    } else if (type === 'user') {
        p.classList.add('bg-green-50');
        strong.classList.add('text-green-700'); // Use a green shade for user
        strong.textContent = "User: ";
    } else { // system messages
        p.classList.add('bg-gray-100', 'text-gray-600', 'italic');
        strong.textContent = ""; // No prefix for system messages
    }

    p.appendChild(strong);
    p.appendChild(document.createTextNode(text)); // Append actual text after strong tag
    container.appendChild(p);

    // Scroll to bottom
    transcriptionContainer.scrollTop = transcriptionContainer.scrollHeight;
}

// Function to add system messages (like status updates)
function addSystemMessage(text: string) {
     addTranscriptionMessage(text, 'system');
}

// Function to update the End Screen message
function updateEndScreenMessage(text: string, isError: boolean = false) {
    if (endMessageElement) {
        endMessageElement.textContent = text;
        endMessageElement.classList.toggle('text-red-500', isError);
        endMessageElement.classList.toggle('text-brand-text-secondary', !isError);
    }
}

// Modified to use the new message structure
function appendToTextBlock(text: string) {
    const container = transcriptionContainer.querySelector('#received-text-container');
    if (!container) return;

    let lastP = container.lastElementChild as HTMLParagraphElement;
    // Ensure the last element is a paragraph and likely an AI message (heuristic)
    if (!lastP || !lastP.textContent?.startsWith('AI:')) {
        addTranscriptionMessage(text, 'ai'); // Start a new block if needed
    } else {
        // Append to the existing AI message block
        lastP.appendChild(document.createTextNode(text));
    }
    // Scroll to bottom
    transcriptionContainer.scrollTop = transcriptionContainer.scrollHeight;
}

// --- Event Listeners ---

let currentInterviewConfig: InterviewConfig | null = null; // Store fetched config

joinButtonElement.addEventListener("click", async () => {
    const code = interviewCodeInputElement.value.trim();
    if (!code) {
        joinErrorElement.textContent = "Please enter an interview code.";
        setUIState(UIState.Error);
        return;
    }

    setUIState(UIState.ValidatingCode);
    joinErrorElement.style.display = 'none'; // Hide error initially

    // --- Actual Backend API Call ---
    try {
        // Assuming backend runs on port 3000 (adjust if different)
        const response = await fetch(`http://localhost:3000/api/interview/${code}/config`);

        if (response.ok) {
            const fetchedConfig = await response.json();
            // Store the code along with the fetched config
            currentInterviewConfig = { ...fetchedConfig, code: code } as InterviewConfig;
            console.log("!!! currentInterviewConfig set in join listener:", JSON.stringify(currentInterviewConfig)); // ADD THIS LOG

            // Validate fetched config (basic check)
            if (!currentInterviewConfig || !currentInterviewConfig.endpoint || !currentInterviewConfig.apiKey || !currentInterviewConfig.deployment || !currentInterviewConfig.systemPrompt) {
                 console.error("Incomplete configuration received from backend:", currentInterviewConfig);
                 joinErrorElement.textContent = "Invalid configuration received from server.";
                 setUIState(UIState.Error);
                 return;
            }

            console.log("Configuration received:", currentInterviewConfig);
            setUIState(UIState.RequestingPermissions);
            const permissionsGranted = await requestPermissionsAndSetupMedia();
            if (permissionsGranted) {
                setUIState(UIState.InterviewReady);
            }
            // Error/state handling for permissions is done within requestPermissionsAndSetupMedia

        } else {
            const errorData = await response.json().catch(() => ({ message: 'Unknown error' })); // Try to parse error message
            console.error(`Error fetching config: ${response.status}`, errorData);
            joinErrorElement.textContent = errorData.message || `Error: ${response.status}`;
            setUIState(UIState.Error);
        }
    } catch (error) {
        console.error("Error fetching config:", error);
        joinErrorElement.textContent = "Network error or backend is unavailable.";
        setUIState(UIState.Error);
    }
});


startInterviewButton.addEventListener("click", async () => {
    if (!currentInterviewConfig) {
        alert("Configuration not loaded. Cannot start interview.");
        setUIState(UIState.JoinScreen); // Go back to join screen
        return;
    }
    if (!recordingActive) {
        alert("Media permissions not granted or setup failed.");
         setUIState(UIState.RequestingPermissions); // Try permissions again? Or JoinScreen?
        return;
    }

    setUIState(UIState.Connecting);
    addSystemMessage("<< Connecting to interview session... >>");

    try {
        await start_realtime(currentInterviewConfig);
        // State is set to InterviewInProgress within handleRealtimeMessages on session.created
    } catch (error) {
        console.error("Error starting realtime session:", error);
        addSystemMessage(`[Error] Failed to start interview session: ${error}`);
        stopInterviewCleanup(); // Cleanup media and state
        setUIState(UIState.Error); // Or InterviewEnded/JoinScreen?
    }
});

stopInterviewButton.addEventListener("click", async () => {
    stopInterviewCleanup();
});

// Removed clear all button listener
// Removed endpoint change listener and guessIfIsAzureOpenAI call

// --- Timer Logic ---
let timerInterval: number | null = null;
let timeRemaining: number = 0;

function startTimer(durationSeconds: number) {
    stopTimer(); // Clear any existing timer
    timeRemaining = durationSeconds;
    updateTimerDisplay();
    timerInterval = window.setInterval(() => {
        timeRemaining--;
        updateTimerDisplay();
        if (timeRemaining <= 0) {
            stopTimer();
            addSystemMessage("<< Time Limit Reached >>");
            stopInterviewCleanup(); // Automatically end the interview
        }
    }, 1000);
}

function stopTimer() {
    if (timerInterval !== null) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function updateTimerDisplay() {
    const minutes = Math.floor(timeRemaining / 60);
    const seconds = timeRemaining % 60;
    timerElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// --- Initial State ---
setUIState(UIState.JoinScreen); // Start at the join screen