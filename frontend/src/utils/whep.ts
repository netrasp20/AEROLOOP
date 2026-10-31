export class WhepClient {
  private pc: RTCPeerConnection | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;

  async connect(whepUrl: string, videoEl: HTMLVideoElement): Promise<void> {
    this.video = videoEl;

    const offerRes = await fetch(whepUrl, { method: "POST" });
    if (!offerRes.ok) throw new Error(`WHEP offer failed: ${offerRes.status}`);
    const offerSdp = await offerRes.text();

    this.pc = new RTCPeerConnection({ iceServers: [] });

    this.pc.onconnectionstatechange = () => {
      if (this.pc?.connectionState === "failed" || this.pc?.connectionState === "disconnected") {
        this.close();
      }
    };

    this.pc.ontrack = (event) => {
      this.stream = event.streams[0];
      if (this.video) this.video.srcObject = this.stream;
    };

    await this.pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    const answerRes = await fetch(whepUrl, {
      method: "PATCH",
      body: answer.sdp,
      headers: { "Content-Type": "application/sdp" },
    });

    if (!answerRes.ok) {
      this.close();
      throw new Error(`WHEP answer failed: ${answerRes.status}`);
    }
  }

  close(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
  }

  isConnected(): boolean {
    return this.pc?.connectionState === "connected";
  }
}
