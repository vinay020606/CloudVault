import express from 'express';
import { generateAccessToken, ROLES } from '../services/authService.js';
import { authenticateTenant } from '../middleware/authMiddleware.js';

const router = express.Router();

/**
 * POST /api/v1/auth/token
 * Body: { tenantId: string, role?: 'ADMIN' | 'DEVELOPER' | 'VIEWER', userId?: string }
 * Returns signed JWT token
 */
router.post('/token', (req, res) => {
  const { tenantId, role = ROLES.DEVELOPER, userId = 'user_101' } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: 'Missing tenantId parameter in request body' });
  }

  try {
    const token = generateAccessToken({ tenantId, role, userId });
    return res.status(201).json({
      message: 'Access token generated successfully',
      token,
      tenantId,
      role,
      userId,
      expiresIn: '24h',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/auth/me
 * Headers: Authorization: Bearer <token>
 * Returns authenticated user details and permissions
 */
router.get('/me', authenticateTenant, (req, res) => {
  return res.json({
    user: req.user,
    message: 'Token is valid and active',
  });
});

export default router;
