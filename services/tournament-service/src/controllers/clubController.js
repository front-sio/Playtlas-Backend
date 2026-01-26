const { prisma } = require('../config/db');
const logger = require('../utils/logger');

exports.createClub = async (req, res) => {
  try {
    const { name, locationText, status } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    const club = await prisma.club.create({
      data: {
        name,
        locationText: locationText || null,
        status: status || 'active'
      }
    });

    res.status(201).json({ success: true, data: club });
  } catch (error) {
    logger.error('Create club error:', error);
    res.status(500).json({ success: false, error: 'Failed to create club' });
  }
};

exports.getClubs = async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (status) where.status = status;

    const clubs = await prisma.club.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit, 10),
      skip: parseInt(offset, 10)
    });

    res.json({ success: true, data: clubs });
  } catch (error) {
    logger.error('Get clubs error:', error);
    res.status(500).json({ success: false, error: 'Failed to get clubs' });
  }
};

exports.getClub = async (req, res) => {
  try {
    const { clubId } = req.params;
    const club = await prisma.club.findUnique({ where: { clubId } });
    if (!club) {
      return res.status(404).json({ success: false, error: 'Club not found' });
    }
    res.json({ success: true, data: club });
  } catch (error) {
    logger.error('Get club error:', error);
    res.status(500).json({ success: false, error: 'Failed to get club' });
  }
};

exports.updateClub = async (req, res) => {
  try {
    const { clubId } = req.params;
    const { name, locationText, status } = req.body;

    const existing = await prisma.club.findUnique({ where: { clubId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Club not found' });
    }

    const club = await prisma.club.update({
      where: { clubId },
      data: {
        name: name ?? existing.name,
        locationText: locationText ?? existing.locationText,
        status: status ?? existing.status
      }
    });

    res.json({ success: true, data: club });
  } catch (error) {
    logger.error('Update club error:', error);
    res.status(500).json({ success: false, error: 'Failed to update club' });
  }
};

exports.deleteClub = async (req, res) => {
  try {
    const { clubId } = req.params;
    await prisma.club.delete({ where: { clubId } });
    res.json({ success: true });
  } catch (error) {
    logger.error('Delete club error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete club' });
  }
};
