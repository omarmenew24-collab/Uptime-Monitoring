import { z } from 'zod';

const urlPattern = /^https?:\/\/.+\..+/;

export const createMonitorSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
  url: z.string().trim().regex(urlPattern, 'Must be a valid HTTP or HTTPS URL with a domain'),
  interval_minutes: z.number().refine(
    (val) => [1, 5, 10, 30, 60].includes(val),
    'Must be 1, 5, 10, 30, or 60'
  ).default(5),
  failure_threshold: z.number().refine(
    (val) => [1, 2, 3, 5].includes(val),
    'Must be 1, 2, 3, or 5'
  ).default(2),
});
