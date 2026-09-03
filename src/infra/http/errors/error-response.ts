import { z } from 'zod'

export const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR'
export const VALIDATION_ERROR_MESSAGE = 'Invalid payload'

export const BAD_REQUEST_CODE = 'BAD_REQUEST'
export const TOO_MANY_REQUESTS_CODE = 'TOO_MANY_REQUESTS'
export const ROUTE_NOT_FOUND_CODE = 'ROUTE_NOT_FOUND'
export const ROUTE_NOT_FOUND_MESSAGE = 'Route not found'

export const INTERNAL_SERVER_ERROR_CODE = 'INTERNAL_SERVER_ERROR'
export const INTERNAL_SERVER_ERROR_MESSAGE = 'Internal server error'

const validationDetailSchema = z.object({
  field: z.string().optional(),
  code: z.string(),
})

/**
 * The public shape of every error this API returns. Single source of truth for
 * the handler, for OpenAPI, and for the example in ARCHITECTURE.md.
 *
 * `code` is contract and stable; `message` is for logs and debugging and must
 * never be shown raw in a localized client.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(validationDetailSchema).optional(),
    traceId: z.string(),
  }),
})

export type ErrorResponse = z.infer<typeof errorResponseSchema>
