import rateLimit from 'express-rate-limit';

// Broad enough for coordinated incident workflows, while limiting automated
// mutation and recommendation abuse. Authentication has a stricter limiter.
export const sensitiveOperationLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: req => !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method),
  message: { message: 'Too many changes in a short period. Wait briefly and try again.' },
});
