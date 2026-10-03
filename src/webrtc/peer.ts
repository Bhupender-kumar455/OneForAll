/**
 * WebRTC peer (RTCPeerConnection) factory.
 *
 * Wraps the browser's connection object with promise-returning helpers for the
 * offer/answer dance and exposes the negotiated DataChannel to the transfer
 * layer.  DOM WebRTC classes are used as globals (see tsconfig `lib: dom`).
 */
import type { TransferId } from "./types";

export interface IceConfig {
  iceServers: RTCIceServer[];
}

export function buildIceConfig(): IceConfig {
  const servers: RTCIceServer[] = [
    {
      urls: `stun:${import.meta.env.VITE_WEBRTC_STUN ?? "stun.l.google.com:19302"}`,
    },
  ];
  const turnUrl = import.meta.env.VITE_WEBRTC_TURN_URL;
  const turnUsername = import.meta.env.VITE_WEBRTC_TURN_USERNAME;
  const turnCredential = import.meta.env.VITE_WEBRTC_TURN_CREDENTIAL;
  if (turnUrl && turnUsername && turnCredential) {
    servers.push({ urls: turnUrl, username: turnUsername, credential: turnCredential });
  }
  return { iceServers: servers };
}

export class Peer {
  private readonly transferId: TransferId;
  private readonly _pc: RTCPeerConnection;
  private _dataChannel: RTCDataChannel | null = null;
  private readonly onIceCandidate: (candidate: RTCIceCandidate) => void;
  private readonly onIceConnectionState: (state: string) => void;
  private readonly onConnectionStateChange: (state: string) => void;

  constructor(
    transferId: TransferId,
    onIceCandidate: (candidate: RTCIceCandidate) => void,
    onIceConnectionState: (state: string) => void,
    onConnectionStateChange: (state: string) => void,
  ) {
    this.transferId = transferId;
    this._pc = new RTCPeerConnection(buildIceConfig());
    this.onIceCandidate = onIceCandidate;
    this.onIceConnectionState = onIceConnectionState;
    this.onConnectionStateChange = onConnectionStateChange;

    // Receiver side: the sender's channel arrives via this event.
    this._pc.ondatachannel = (event: RTCDataChannelEvent) => {
      this._dataChannel = event.channel;
      this.installChannelLogging(event.channel);
    };

    this._pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) this.onIceCandidate(event.candidate);
    };
    this._pc.oniceconnectionstatechange = () => {
      this.onIceConnectionState(this._pc.iceConnectionState);
    };
    this._pc.onconnectionstatechange = () => {
      this.onConnectionStateChange(this._pc.connectionState);
    };
  }

  public get pc(): RTCPeerConnection {
    return this._pc;
  }

  public get dataChannel(): RTCDataChannel | null {
    return this._dataChannel;
  }

  /** Sender side: create the ordered, reliable channel used for the file. */
  public createDataChannel(): RTCDataChannel {
    if (!this._dataChannel) {
      const channel = this._pc.createDataChannel("file", { ordered: true });
      this._dataChannel = channel;
      this.installChannelLogging(channel);
    }
    return this._dataChannel;
  }

  public async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    return offer;
  }

  /** Receiver side: apply the offer, then produce and store the answer. */
  public async acceptOffer(
    offer: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit> {
    await this._pc.setRemoteDescription(offer);
    const answer = await this._pc.createAnswer();
    await this._pc.setLocalDescription(answer);
    return answer;
  }

  public async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this._pc.setRemoteDescription(answer);
  }

  public addIceCandidate(candidate: RTCIceCandidate | RTCIceCandidateInit): Promise<void> {
    return this._pc.addIceCandidate(candidate);
  }

  public get connectionState(): RTCPeerConnectionState {
    return this._pc.connectionState;
  }

  public close(): void {
    this._pc.close();
    this._dataChannel = null;
  }

  /**
   * Wait for the DataChannel to open (or fail / close first).
   */
  public waitForChannelOpen(channel: RTCDataChannel, timeoutMs = 30_000): Promise<void> {
    if (channel.readyState === "open") return Promise.resolve();

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        channel.removeEventListener("open", onOpen);
        channel.removeEventListener("close", onClose);
        channel.removeEventListener("error", onError);
        clearTimeout(timer);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("DataChannel closed before it opened"));
      };
      const onError = () => {
        cleanup();
        reject(new Error("DataChannel failed to open"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for the DataChannel"));
      }, timeoutMs);

      channel.addEventListener("open", onOpen);
      channel.addEventListener("close", onClose);
      channel.addEventListener("error", onError);
    });
  }

  /** Receiver side: wait for the channel the sender opens. */
  public waitForDataChannel(timeoutMs = 30_000): Promise<RTCDataChannel> {
    if (this._dataChannel) return Promise.resolve(this._dataChannel);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (this._dataChannel) {
          resolve(this._dataChannel);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error("Timed out waiting for the DataChannel"));
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
  }

  private installChannelLogging(channel: RTCDataChannel): void {
    channel.binaryType = "arraybuffer";
  }
}
