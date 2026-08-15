# ADR 0003: Timeline controls use boundary directives

Timeline Control is a directive on the current Segment that defines its relation to the immediately preceding Segment during Audio Assembly. Interruption begins the current Segment before its predecessor ends, while Pause inserts explicit silence before it; both use Timeline Mix rather than becoming TTS Engine behavior. This keeps timing portable across Engine Plugins and makes manual source intent authoritative while automatic Pause recommendation is deferred.

**Considered Options**:
- Treat Pause as an Interruption variant — rejected because its positive delay and silence are semantically opposite to overlap and attenuation.
- Delegate Pause to punctuation or individual TTS Engines — rejected because duration would be engine-dependent and subtitles could not be placed on a shared timeline.
- Make LLM Recommendation infer Pause in the first release — deferred because normal punctuation pauses are common and automated inference would routinely add unintended silence.
