import type { ApiErrorBody, BillingRisk } from '@studio/domain'

/**
 * US-013 统一错误封套:稳定 code + 用户可读 message + scope + nextAction +
 * retryable + billingRisk。四类必须分开:权限(403)/额度与配额/输入(400)/
 * 提交未知(submission_unknown——不自动重试,可能重复计费)。基础设施错误与
 * 上游错误分开;原始诊断(堆栈/内部 id)不进响应,只进服务端日志。
 */
export function apiError(
  code: string,
  message: string,
  options: { scope?: string[]; nextAction?: string; retryable?: boolean; billingRisk?: BillingRisk } = {},
): { statusCode: number; body: ApiErrorBody } {
  const statusByCode: Record<string, number> = {
    invalid_argument: 400,
    unauthenticated: 401,
    forbidden: 403,
    not_found: 404,
    version_conflict: 409,
    state_conflict: 409,
    capability_conflict: 409,
    submission_unknown: 202,
  }
  return {
    statusCode: statusByCode[code] ?? 500,
    body: {
      code,
      message,
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
      ...(options.nextAction !== undefined ? { nextAction: options.nextAction } : {}),
      retryable: options.retryable ?? false,
      billingRisk: options.billingRisk ?? 'none',
    },
  }
}

/** 从 Fastify 错误响应中提取封套字段;旧式 {error} 响应归一为 internal 的形态。 */
export function parseApiError(statusCode: number, body: unknown): ApiErrorBody {
  if (typeof body === 'object' && body !== null && 'code' in body && typeof (body as { code: unknown }).code === 'string') {
    return body as ApiErrorBody
  }
  const legacyMessage = typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${statusCode}`
  return {
    code: statusCode >= 500 ? 'internal' : 'invalid_argument',
    message: legacyMessage,
    retryable: statusCode >= 500,
    billingRisk: 'none',
  }
}
