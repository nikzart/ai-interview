// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export class Recorder {
  onDataAvailable: (buffer: Buffer) => void;
  private audioContext: AudioContext | null = null;
  // private mediaStream: MediaStream | null = null; // No longer needed directly
  private mediaStreamSource: MediaStreamAudioSourceNode | null = null; // Keep reference to disconnect
  private workletNode: AudioWorkletNode | null = null; // Keep reference to disconnect

  public constructor(onDataAvailable: (buffer: Buffer) => void) {
    this.onDataAvailable = onDataAvailable;
  }

  // Accept AudioContext, the microphone source node, and the destination for mixed audio
  async start(context: AudioContext, sourceNode: MediaStreamAudioSourceNode, destination: AudioNode) {
    try {
      this.audioContext = context; // Store shared context
      this.mediaStreamSource = sourceNode; // Store source node

      // Ensure the worklet path is correct relative to the HTML file
      await this.audioContext.audioWorklet.addModule(
        "./audio-worklet-processor.js",
      );

      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        "audio-worklet-processor", // Name registered in the worklet script
      );

      // Listen for processed audio data from the worklet
      this.workletNode.port.onmessage = (event) => {
        // This data is the raw microphone audio for sending to Azure
        this.onDataAvailable(event.data.buffer);
      };

      // Connect microphone source to the worklet processor (for Azure)
      this.mediaStreamSource.connect(this.workletNode);

      // Connect the worklet processor to the main context destination (optional, for local playback if needed)
      // this.workletNode.connect(this.audioContext.destination);
      // IMPORTANT: Do NOT connect the workletNode directly to the destination if it contains only mic audio,
      // otherwise, the user hears their own voice directly.

      // ALSO connect the original microphone source directly to the MIXER destination (for recording)
      this.mediaStreamSource.connect(destination);

    } catch (error) {
        console.error("Error starting recorder:", error);
        this.stop(); // Attempt cleanup on error
    }
  }

  stop() {
    // Disconnect nodes to release resources
    if (this.mediaStreamSource) {
        this.mediaStreamSource.disconnect();
        this.mediaStreamSource = null;
    }
    if (this.workletNode) {
        this.workletNode.disconnect();
         // Make sure to close the port to prevent memory leaks if applicable
        this.workletNode.port.close();
        this.workletNode = null;
    }
    // Note: We don't stop the original MediaStream tracks here,
    // as that's handled in main.ts where the stream is created.
    // Check state before closing to prevent error
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
  }
}
