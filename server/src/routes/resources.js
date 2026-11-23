import { Router } from 'express';
import { z } from 'zod';
import Resource from '../models/Resource.js';
import Provider from '../models/Provider.js';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { audit } from '../services/record.js';

const router = Router();
const resourceInput = z.object({ providerId: z.string().regex(/^[a-f\d]{24}$/i).optional(), resourceType: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(160), quantityAvailable: z.number().min(0), unit: z.string().trim().min(1).max(40), condition: z.enum(['new', 'good', 'fair', 'poor', 'unknown']).optional(), expirationDate: z.string().datetime().optional() }).strict();
const pageQuery = (query) => ({ page: Math.max(1, Number.parseInt(query.page, 10) || 1), limit: Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 25)) });

router.use(authenticate);
router.post('/', allowRoles('provider', 'coordinator', 'admin'), async (req, res, next) => {
  try {
    const input = resourceInput.parse(req.body);
    let provider;
    if (req.user.role === 'provider') provider = await Provider.findOne({ owner: req.user.id }).select('_id');
    else if (input.providerId) provider = await Provider.findById(input.providerId).select('_id');
    if (!provider) return res.status(404).json({ message: 'Provider profile not found.' });
    if (input.providerId && String(provider._id) !== input.providerId) return res.status(403).json({ message: 'You cannot add inventory to another provider.' });
    const resource = await Resource.create({ ...input, providerId: provider._id, expirationDate: input.expirationDate ? new Date(input.expirationDate) : undefined });
    await audit(req, 'resource.created', 'Resource', resource.id, { resourceType: resource.resourceType, quantityAvailable: resource.quantityAvailable });
    res.status(201).json({ resource });
  } catch (error) { next(error); }
});

router.get('/', async (req, res, next) => {
  try {
    const { page, limit } = pageQuery(req.query);
    const filter = {};
    if (req.query.resourceType) filter.resourceType = String(req.query.resourceType).slice(0, 100);
    if (req.user.role === 'provider') {
      const provider = await Provider.findOne({ owner: req.user.id }).select('_id');
      filter.providerId = provider?._id || null;
    } else if (!['coordinator', 'admin'].includes(req.user.role)) {
      const providers = await Provider.find({ verificationStatus: 'verified' }).select('_id').lean();
      filter.providerId = { $in: providers.map(provider => provider._id) };
    }
    const [resources, total] = await Promise.all([Resource.find(filter).sort({ lastUpdated: -1 }).skip((page - 1) * limit).limit(limit).lean(), Resource.countDocuments(filter)]);
    res.json({ resources, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.patch('/:id', allowRoles('provider', 'coordinator', 'admin'), async (req, res, next) => {
  try {
    const updateSchema = resourceInput.omit({ providerId: true }).partial().refine(value => Object.keys(value).length > 0, 'Provide at least one resource field to update.');
    const input = updateSchema.parse(req.body);
    const resource = await Resource.findById(req.params.id);
    if (!resource) return res.status(404).json({ message: 'Resource not found.' });
    if (req.user.role === 'provider') {
      const ownsResource = await Provider.exists({ _id: resource.providerId, owner: req.user.id });
      if (!ownsResource) return res.status(403).json({ message: 'You can only update your own provider inventory.' });
    }
    if (input.quantityAvailable !== undefined) resource.quantityAvailable = input.quantityAvailable;
    if (input.resourceType !== undefined) resource.resourceType = input.resourceType;
    if (input.name !== undefined) resource.name = input.name;
    if (input.unit !== undefined) resource.unit = input.unit;
    if (input.condition !== undefined) resource.condition = input.condition;
    if (input.expirationDate !== undefined) resource.expirationDate = new Date(input.expirationDate);
    resource.lastUpdated = new Date();
    await resource.save();
    await audit(req, 'resource.updated', 'Resource', resource.id, Object.keys(input));
    res.json({ resource });
  } catch (error) { next(error); }
});

export default router;
