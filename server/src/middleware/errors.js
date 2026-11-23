export function notFound(_req, res) { res.status(404).json({ message: 'Route not found.' }); }
export function errorHandler(error, _req, res, _next) {
  if (error.name === 'CastError' || error instanceof SyntaxError && 'body' in error) return res.status(400).json({ message: 'The request contains an invalid identifier or malformed JSON.' });
  if (error.name === 'ZodError') return res.status(400).json({ message: 'Validation failed.', details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
  if (error.name === 'ValidationError') return res.status(400).json({ message: 'Validation failed.', details: Object.values(error.errors).map(item => item.message) });
  if (error.code === 11000) return res.status(409).json({ message: 'A record with that value already exists.' });
  console.error(error);
  res.status(error.status || 500).json({ message: error.status ? error.message : 'An unexpected error occurred.' });
}
