export const REDACT_PATHS = [
  'password',
  'token',
  'refreshToken',
  'accessToken',
  '*.password',
  '*.token',
  '*.refreshToken',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
] as const
