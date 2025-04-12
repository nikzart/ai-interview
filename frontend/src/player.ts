// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export class Player {
  private audioContext: AudioContext | null = null; // Store context
  private playbackNode: AudioWorkletNode | null = null;

  // Accept AudioContext and the destination for mixed audio
  async init(context: AudioContext, destination: AudioNode) {
    this.audioContext = context; // Store the shared context
    // Ensure the worklet path is correct relative to the HTML file
    await this.audioContext.audioWorklet.addModule("./playback-worklet.js");

    this.playbackNode = new AudioWorkletNode(this.audioContext, "playback-worklet");
    // Connect the player output to the provided destination (for recording)
    this.playbackNode.connect(destination);
    // ALSO connect to the main context destination (for candidate to hear)
    this.playbackNode.connect(this.audioContext.destination);
  }

  play(buffer: Int16Array) {
    if (this.playbackNode) {
      this.playbackNode.port.postMessage(buffer);
    }
  }

  clear() {
    // Send message to clear buffer in worklet
    if (this.playbackNode) {
      this.playbackNode.port.postMessage(null);
    }
    // Note: We don't close the audioContext here as it's shared
  }
}
