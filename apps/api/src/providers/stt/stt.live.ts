import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';

import { CONFIG, type AppConfig } from '../../config/configuration';
import {
  ProviderError,
  type SttProvider,
  type TranscribeInput,
  type TranscribeResult,
  type TranscriptTurn,
} from '../provider.types';

interface DeepgramUtterance {
  speaker?: number;
  transcript: string;
  start: number;
  end: number;
  confidence: number;
}

@Injectable()
export class SttLiveProvider implements SttProvider {
  readonly name = 'stt';
  readonly mode = ProviderMode.LIVE;

  private readonly logger = new Logger(SttLiveProvider.name);

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    if (!input.audioUrl && !input.audioBuffer) {
      throw new ProviderError('stt', 'transcribe', 'no_audio', 'Neither audioUrl nor audioBuffer was supplied', false);
    }

    if (!this.config.deepgram.apiKey) {
      if (this.config.gemini.apiKey) {
        this.logger.warn('DEEPGRAM_API_KEY not configured — falling back to Gemini for transcription');
        return this.transcribeWithGemini(input);
      }
      throw new ProviderError('stt', 'transcribe', 'missing_api_key', 'DEEPGRAM_API_KEY is not configured', false);
    }

    const params = new URLSearchParams({
      model: this.config.deepgram.model,
      diarize: 'true',
      punctuate: 'true',
      utterances: 'true',
      smart_format: 'true',
      language: input.languageHint ?? 'multi',
      multichannel: 'true',
    });

    const headers: Record<string, string> = { authorization: `Token ${this.config.deepgram.apiKey}` };
    let body: string | Uint8Array;

    if (input.audioBuffer) {
      headers['content-type'] = input.mimeType ?? 'audio/mpeg';
      body = input.audioBuffer;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({ url: input.audioUrl });
    }

    const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: 'POST',
      headers,
      body,
    }).catch((error: unknown) => {
      throw new ProviderError('stt', 'transcribe', 'network_error', (error as Error).message, true);
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ProviderError(
        'stt',
        'transcribe',
        String(response.status),
        `Deepgram returned HTTP ${response.status}: ${text.slice(0, 200)}`,
        response.status >= 500 || response.status === 429,
        response.status,
      );
    }

    const payload = (await response.json()) as {
      metadata?: { duration?: number };
      results?: {
        utterances?: DeepgramUtterance[];
        channels?: { detected_language?: string; alternatives?: { transcript?: string; confidence?: number }[] }[];
      };
    };

    const utterances = payload.results?.utterances ?? [];
    console.log('DEEPGRAM UTTERANCES DEBUG:', JSON.stringify(utterances.map(u => ({ speaker: u.speaker, text: u.transcript })), null, 2));

    const turns: TranscriptTurn[] = utterances.map((utterance, index) => ({
      sequence: index + 1,
      speaker: (utterance.speaker ?? 0) === 0 ? 'agent' : 'customer',
      text: utterance.transcript,
      startMs: Math.round(utterance.start * 1000),
      endMs: Math.round(utterance.end * 1000),
      confidence: utterance.confidence,
    }));

    if (turns.length === 0) {
      const fallback = payload.results?.channels?.[0]?.alternatives?.[0];
      if (fallback?.transcript) {
        this.logger.warn('Deepgram returned no utterances; falling back to the flat transcript');
        turns.push({
          sequence: 1,
          speaker: 'customer',
          text: fallback.transcript,
          startMs: 0,
          endMs: Math.round((payload.metadata?.duration ?? 0) * 1000),
          confidence: fallback.confidence ?? 0,
        });
      }
    }

    const averageConfidence = turns.length
      ? turns.reduce((total, turn) => total + turn.confidence, 0) / turns.length
      : 0;

    return {
      turns,
      durationSeconds: Math.round(payload.metadata?.duration ?? 0),
      language: payload.results?.channels?.[0]?.detected_language ?? (input.languageHint ?? 'multi'),
      averageConfidence,
    };
  }

  private async transcribeWithGemini(input: TranscribeInput): Promise<TranscribeResult> {
    let audioBytes: Buffer;
    let mimeType = input.mimeType ?? 'audio/mpeg';

    if (input.audioBuffer) {
      audioBytes = input.audioBuffer;
    } else if (input.audioUrl) {
      const audioResponse = await fetch(input.audioUrl).catch((error: unknown) => {
        throw new ProviderError('stt', 'transcribe', 'network_error', (error as Error).message, true);
      });
      if (!audioResponse.ok) {
        throw new ProviderError(
          'stt',
          'transcribe',
          String(audioResponse.status),
          `Fetching recording audio failed with HTTP ${audioResponse.status}`,
          audioResponse.status >= 500,
          audioResponse.status,
        );
      }
      const contentType = audioResponse.headers.get('content-type');
      if (contentType) mimeType = contentType.split(';')[0]!.trim();
      audioBytes = Buffer.from(await audioResponse.arrayBuffer());
    } else {
      throw new ProviderError('stt', 'transcribe', 'no_audio', 'Neither audioUrl nor audioBuffer was supplied', false);
    }

    const base64Audio = audioBytes.toString('base64');

    const prompt = [
      'Transcribe this phone call recording turn by turn.',
      'The call is between an "agent" (the person who placed the call) and a "customer" (the person who answered).',
      'Return each spoken turn in order, in the language actually spoken (the call may mix Hindi and English).',
      input.context?.contactName ? `The customer's name is ${input.context.contactName}.` : '',
      input.context?.purpose ? `The purpose of the call was: ${input.context.purpose}.` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Audio } }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2000,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            language: { type: 'STRING' },
            turns: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  speaker: { type: 'STRING', enum: ['agent', 'customer'] },
                  text: { type: 'STRING' },
                  startSeconds: { type: 'NUMBER' },
                  endSeconds: { type: 'NUMBER' },
                },
                required: ['speaker', 'text'],
              },
            },
          },
          required: ['turns'],
        },
      },
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.config.gemini.model}:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.config.gemini.apiKey },
      body: JSON.stringify(body),
    }).catch((error: unknown) => {
      throw new ProviderError('stt', 'transcribe', 'network_error', (error as Error).message, true);
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ProviderError(
        'stt',
        'transcribe',
        String(response.status),
        `Gemini returned HTTP ${response.status}: ${text.slice(0, 200)}`,
        response.status >= 500 || response.status === 429,
        response.status,
      );
    }

    const payload = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      promptFeedback?: { blockReason?: string };
    };

    if (payload.promptFeedback?.blockReason) {
      throw new ProviderError(
        'stt',
        'transcribe',
        `blocked_${payload.promptFeedback.blockReason}`,
        `Gemini blocked the request: ${payload.promptFeedback.blockReason}`,
        false,
      );
    }

    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new ProviderError('stt', 'transcribe', 'empty_response', 'Gemini returned no content', true);
    }

    let parsed: { language?: string; turns: { speaker: string; text: string; startSeconds?: number; endSeconds?: number }[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      this.logger.warn(`Gemini transcription returned unparseable JSON: ${text.slice(0, 200)}`);
      throw new ProviderError('stt', 'transcribe', 'invalid_json', 'Gemini returned malformed JSON', true);
    }

    const turns: TranscriptTurn[] = (parsed.turns ?? []).map((turn, index) => ({
      sequence: index + 1,
      speaker: turn.speaker === 'agent' ? 'agent' : 'customer',
      text: turn.text,
      startMs: Math.round((turn.startSeconds ?? 0) * 1000),
      endMs: Math.round((turn.endSeconds ?? turn.startSeconds ?? 0) * 1000),
      confidence: 0.9,
    }));

    const lastEndMs = turns.length ? turns[turns.length - 1]!.endMs : 0;

    return {
      turns,
      durationSeconds: Math.round(lastEndMs / 1000),
      language: parsed.language ?? (input.languageHint ?? 'multi'),
      averageConfidence: turns.length ? 0.9 : 0,
    };
  }
}