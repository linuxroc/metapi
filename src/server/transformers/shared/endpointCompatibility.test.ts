import { describe, expect, it } from 'vitest';

import {
  hasEndpointMismatchHint,
  inferRequiredEndpointFromProtocolError,
  inferSuggestedEndpointFromUpstreamError,
  isEndpointDowngradeError,
  promoteRequiredEndpointCandidateAfterProtocolError,
} from './endpointCompatibility.js';

describe('inferRequiredEndpointFromProtocolError', () => {
  it('recognizes messages-required protocol errors', () => {
    expect(inferRequiredEndpointFromProtocolError('messages is required')).toBe('messages');
    expect(inferRequiredEndpointFromProtocolError('{"error":{"message":"messages is required"}}')).toBe('messages');
  });

  it('recognizes responses-input-required protocol errors', () => {
    expect(inferRequiredEndpointFromProtocolError('input is required')).toBe('responses');
    expect(inferRequiredEndpointFromProtocolError('{"error":{"message":"input is required"}}')).toBe('responses');
  });

  it('ignores unrelated protocol errors', () => {
    expect(inferRequiredEndpointFromProtocolError('unsupported endpoint')).toBeNull();
    expect(inferRequiredEndpointFromProtocolError('')).toBeNull();
    expect(inferRequiredEndpointFromProtocolError(null)).toBeNull();
  });
});

describe('inferSuggestedEndpointFromUpstreamError', () => {
  it('prefers required endpoints over generic path mentions', () => {
    expect(inferSuggestedEndpointFromUpstreamError('input is required for /v1/chat/completions')).toBe('responses');
  });

  it('infers suggested endpoints from explicit upstream endpoint mentions', () => {
    expect(inferSuggestedEndpointFromUpstreamError('Unsupported endpoint /v1/messages')).toBe('messages');
    expect(inferSuggestedEndpointFromUpstreamError('POST /v1/responses is not supported')).toBe('responses');
  });
});

describe('hasEndpointMismatchHint', () => {
  it('recognizes endpoint mismatch vocabulary from raw or parsed errors', () => {
    expect(hasEndpointMismatchHint('Unsupported endpoint /v1/messages')).toBe(true);
    expect(hasEndpointMismatchHint('{"error":{"message":"Unknown endpoint /v1/responses"}}')).toBe(true);
  });

  it('ignores generic upstream errors without endpoint hints', () => {
    expect(hasEndpointMismatchHint('{"error":{"type":"upstream_error","message":"Upstream request failed"}}')).toBe(false);
    expect(hasEndpointMismatchHint('{"error":{"message":"model not found"}}')).toBe(false);
    expect(hasEndpointMismatchHint('{"error":{"message":"resource does not exist"}}')).toBe(false);
    expect(hasEndpointMismatchHint('{"error":{"message":"unsupported image format"}}')).toBe(false);
  });

  it('recognizes localized endpoint mismatch vocabulary without matching model errors', () => {
    expect(hasEndpointMismatchHint('接口不存在')).toBe(true);
    expect(hasEndpointMismatchHint('不支持该端点')).toBe(true);
    expect(hasEndpointMismatchHint('请求路径未找到')).toBe(true);
    expect(hasEndpointMismatchHint('该路由不存在')).toBe(true);
    expect(hasEndpointMismatchHint('当前模型不支持图片输入')).toBe(false);
  });
});

describe('isEndpointDowngradeError', () => {
  it('does not downgrade generic invalid requests without endpoint mismatch evidence', () => {
    expect(isEndpointDowngradeError(400, JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: 'request validation failed',
      },
    }))).toBe(false);
  });

  it('still downgrades invalid requests that explicitly identify an endpoint mismatch', () => {
    expect(isEndpointDowngradeError(400, JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: 'unsupported endpoint /v1/chat/completions',
      },
    }))).toBe(true);
  });

  it('downgrades localized endpoint mismatch errors on HTTP 400', () => {
    expect(isEndpointDowngradeError(400, '接口不存在')).toBe(true);
    expect(isEndpointDowngradeError(400, '{"error":{"message":"请求路径未找到"}}')).toBe(true);
    expect(isEndpointDowngradeError(400, '当前模型不支持图片输入')).toBe(false);
  });

  it('does not downgrade business, model, parameter, or content errors', () => {
    expect(isEndpointDowngradeError(404, '{"error":{"type":"invalid_request_error","message":"model not found"}}')).toBe(false);
    expect(isEndpointDowngradeError(404, '{"error":{"type":"not_found_error","code":"not_found","message":"file not found"}}')).toBe(false);
    expect(isEndpointDowngradeError(400, '{"error":{"message":"unsupported parameter: temperature"}}')).toBe(false);
    expect(isEndpointDowngradeError(400, '{"error":{"message":"unsupported image format"}}')).toBe(false);
    expect(isEndpointDowngradeError(400, '{"error":{"code":"bad_response_status_code","message":"upstream returned 502"}}')).toBe(false);
  });

  it('downgrades only explicit endpoint failures for ambiguous HTTP 404 responses', () => {
    expect(isEndpointDowngradeError(404, '{"error":{"message":"endpoint not found: /v1/messages"}}')).toBe(true);
    expect(isEndpointDowngradeError(404, 'Cannot POST /v1/responses')).toBe(true);
    expect(isEndpointDowngradeError(404, 'not found')).toBe(false);
  });
});

describe('promoteRequiredEndpointCandidateAfterProtocolError', () => {
  it('promotes the required endpoint to the next slot when it appears later in the order', () => {
    const candidates: Array<'chat' | 'messages' | 'responses'> = ['chat', 'messages', 'responses'];

    promoteRequiredEndpointCandidateAfterProtocolError(candidates, {
      currentEndpoint: 'chat',
      upstreamErrorText: 'input is required',
    });

    expect(candidates).toEqual(['chat', 'responses', 'messages']);
  });

  it('does nothing when the required endpoint is already next or missing', () => {
    const alreadyNext: Array<'chat' | 'messages' | 'responses'> = ['chat', 'messages', 'responses'];
    promoteRequiredEndpointCandidateAfterProtocolError(alreadyNext, {
      currentEndpoint: 'chat',
      upstreamErrorText: 'messages is required',
    });
    expect(alreadyNext).toEqual(['chat', 'messages', 'responses']);

    const missingTarget: Array<'chat' | 'messages' | 'responses'> = ['chat', 'messages'];
    promoteRequiredEndpointCandidateAfterProtocolError(missingTarget, {
      currentEndpoint: 'chat',
      upstreamErrorText: 'input is required',
    });
    expect(missingTarget).toEqual(['chat', 'messages']);
  });
});
