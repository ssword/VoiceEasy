# ADR 0002: Doubao Engine uses API Key authentication and single-direction Streaming

The Doubao TTS Engine uses Volcengine's current `X-Api-Key` and `X-Api-Resource-Id` headers. Non-streaming synthesis uses the HTTP audio-generation endpoint, while EasyVoice Streaming uses the single-direction WebSocket endpoint. The Engine Plugin owns request framing, Base64/audio decoding, terminal events and upstream errors.

**Considered Options**:
- Legacy App ID plus Access Key authentication — rejected because the supplied API reference identifies API Key authentication as the current interface and says the legacy console method will be retired.
- Asynchronous long-text submit/query — rejected because it does not provide progressive audio and is unnecessary when EasyVoice already splits long text into Segments.
- Non-streaming HTTP wrapped as a `Readable` — rejected because it would mislabel buffered upstream work as Streaming.
- Bidirectional WebSocket — rejected because EasyVoice sends complete Segment text and does not need incremental text input.

**Consequences**:
- Doubao Streaming can begin playback as upstream audio events arrive, while non-streaming synthesis returns a complete Buffer.
- The public `TTSEngine` interface remains unchanged and Volcengine protocol details do not leak into orchestration services.
- Initial Doubao subtitle support is disabled even though the upstream API can return word timestamps, because the current Engine contract has no metadata return channel.
- The initial Voice List is static and includes the documented `zh_female_tianmeitaozi_mars_bigtts` example; dynamic HMAC-signed Voice discovery is deferred.
