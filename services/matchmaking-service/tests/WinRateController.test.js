const WinRateController = require('../src/services/WinRateController');
const { PrismaClient } = require('@prisma/client');

// Mock Prisma for testing
jest.mock('@prisma/client', () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      aiProfile: {
        findMany: jest.fn(),
        findUnique: jest.fn()
      },
      match: {
        findMany: jest.fn(),
        update: jest.fn()
      },
      aiWinRateStats: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn()
      }
    }))
  };
});

const prisma = new PrismaClient();

describe('WinRateController', () => {
  let controller;
  
  beforeEach(() => {
    controller = new WinRateController({
      target: 0.52,
      windowSize: 100,
      maxStreak: 4,
      jitter: 0.02,
      minMatches: 20
    });
    
    // Clear all mocks
    jest.clearAllMocks();
  });

  describe('Seeded RNG', () => {
    it('should produce deterministic results with same seed', () => {
      const seed = 'test-seed-123';
      const rng1 = controller.createSeededRNG(seed);
      const rng2 = controller.createSeededRNG(seed);
      
      expect(rng1.next()).toBe(rng2.next());
      expect(rng1.next()).toBe(rng2.next());
      expect(rng1.next()).toBe(rng2.next());
    });

    it('should produce different results with different seeds', () => {
      const rng1 = controller.createSeededRNG('seed1');
      const rng2 = controller.createSeededRNG('seed2');
      
      expect(rng1.next()).not.toBe(rng2.next());
    });

    it('should produce values between 0 and 1', () => {
      const rng = controller.createSeededRNG('test');
      
      for (let i = 0; i < 100; i++) {
        const value = rng.next();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    });
  });

  describe('Entry Fee Tier Mapping', () => {
    it('should correctly map entry fees to tiers', () => {
      expect(controller.getTierFromEntryFee(5000)).toBe(1);
      expect(controller.getTierFromEntryFee(10000)).toBe(2);
      expect(controller.getTierFromEntryFee(20000)).toBe(3);
      expect(controller.getTierFromEntryFee(300000)).toBe(10);
      expect(controller.getTierFromEntryFee(999999)).toBe(10); // Cap at tier 10
    });

    it('should correctly map tiers to entry fees', () => {
      expect(controller.getEntryFeeForTier(1)).toBe(5000);
      expect(controller.getEntryFeeForTier(5)).toBe(50000);
      expect(controller.getEntryFeeForTier(10)).toBe(300000);
      expect(controller.getEntryFeeForTier(999)).toBe(5000); // Default fallback
    });
  });

  describe('AI Profile Selection', () => {
    const mockProfiles = [
      { id: '1', name: 'Easy', skillLevel: 20, expectedWinRate: 0.35 },
      { id: '2', name: 'Medium', skillLevel: 50, expectedWinRate: 0.52 },
      { id: '3', name: 'Hard', skillLevel: 80, expectedWinRate: 0.68 }
    ];

    beforeEach(() => {
      prisma.aiProfile.findMany.mockResolvedValue(mockProfiles);
    });

    it('should select random profile when insufficient data', async () => {
      jest.spyOn(controller, 'getWinRateStats').mockResolvedValue({
        totalMatches: 10, // Below minMatches threshold
        rollingWinRate: 0.5,
        currentStreak: 0
      });

      const profile = await controller.selectAiProfile(1, 'test-seed');
      
      expect(profile).toBeDefined();
      expect(mockProfiles).toContain(profile);
    });

    it('should respect streak constraints - force weaker when AI winning too much', async () => {
      jest.spyOn(controller, 'getWinRateStats').mockResolvedValue({
        totalMatches: 50,
        rollingWinRate: 0.6,
        currentStreak: 4, // At max streak
        maxStreak: 4
      });

      const profile = await controller.selectAiProfile(1, 'test-seed');
      
      expect(profile.expectedWinRate).toBeLessThan(0.45);
    });

    it('should respect streak constraints - force stronger when AI losing too much', async () => {
      jest.spyOn(controller, 'getWinRateStats').mockResolvedValue({
        totalMatches: 50,
        rollingWinRate: 0.3,
        currentStreak: -4, // At max losing streak
        maxStreak: 4
      });

      const profile = await controller.selectAiProfile(1, 'test-seed');
      
      expect(profile.expectedWinRate).toBeGreaterThan(0.55);
    });
  });

  describe('Win Rate Statistics', () => {
    it('should calculate rolling win rate correctly', () => {
      const matches = [
        { matchResult: 'AI_WIN' },
        { matchResult: 'HUMAN_WIN' },
        { matchResult: 'AI_WIN' },
        { matchResult: 'AI_WIN' }
      ];

      const winRate = controller.calculateRollingWinRate(matches);
      expect(winRate).toBe(0.75); // 3 AI wins out of 4 matches
    });

    it('should handle empty match list', () => {
      const winRate = controller.calculateRollingWinRate([]);
      expect(winRate).toBe(0);
    });

    it('should calculate streak correctly', async () => {
      const recentMatches = [
        { matchResult: 'HUMAN_WIN' },
        { matchResult: 'AI_WIN' },
        { matchResult: 'AI_WIN' },
        { matchResult: 'AI_WIN' }
      ];
      
      jest.spyOn(controller, 'getRecentMatches').mockResolvedValue(recentMatches);
      
      const stats = await controller.getWinRateStats(1);
      expect(stats.currentStreak).toBe(3); // 3 consecutive AI wins at the end
    });
  });

  describe('Match Result Recording', () => {
    beforeEach(() => {
      prisma.match.update.mockResolvedValue({});
      prisma.aiWinRateStats.findUnique.mockResolvedValue({
        id: 'stats-1',
        aiProfileId: 'profile-1',
        entryFeeTier: 1,
        totalMatches: 49,
        aiWins: 25,
        currentStreak: 2
      });
      prisma.aiWinRateStats.update.mockResolvedValue({});
      jest.spyOn(controller, 'getRecentMatches').mockResolvedValue([]);
    });

    it('should record AI win correctly', async () => {
      await controller.recordMatchResult('match-1', 'profile-1', 1, 'AI_WIN', 'seed-123');
      
      expect(prisma.match.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        data: {
          matchResult: 'AI_WIN',
          endedAt: expect.any(Date)
        }
      });

      expect(prisma.aiWinRateStats.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            totalMatches: 50,
            aiWins: 26,
            currentStreak: 3 // Increment streak
          })
        })
      );
    });

    it('should record human win correctly', async () => {
      await controller.recordMatchResult('match-1', 'profile-1', 1, 'HUMAN_WIN', 'seed-123');
      
      expect(prisma.aiWinRateStats.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            totalMatches: 50,
            aiWins: 25, // No change in AI wins
            currentStreak: -1 // Reset to negative streak
          })
        })
      );
    });
  });

  describe('Weighted Random Selection', () => {
    const items = ['a', 'b', 'c'];
    const rng = { next: jest.fn() };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should select first item when random is at beginning', () => {
      rng.next.mockReturnValue(0.1);
      const weights = [0.5, 0.3, 0.2];
      
      const result = controller.weightedRandomSelection(items, weights, rng);
      expect(result).toBe('a');
    });

    it('should select last item when random is at end', () => {
      rng.next.mockReturnValue(0.9);
      const weights = [0.1, 0.1, 0.8];
      
      const result = controller.weightedRandomSelection(items, weights, rng);
      expect(result).toBe('c');
    });

    it('should handle edge cases gracefully', () => {
      rng.next.mockReturnValue(1.0); // Exactly at boundary
      const weights = [0.33, 0.33, 0.34];
      
      const result = controller.weightedRandomSelection(items, weights, rng);
      expect(items).toContain(result); // Should return valid item
    });
  });
});

// Integration Test: Simulate 10,000 matches
describe('WinRateController Integration Test', () => {
  let controller;
  
  beforeAll(() => {
    controller = new WinRateController({
      target: 0.52,
      windowSize: 100,
      maxStreak: 4,
      jitter: 0.01
    });
  });

  it('should converge to target win rate over many matches', async () => {
    const mockProfiles = [
      { id: '1', expectedWinRate: 0.3, name: 'Easy' },
      { id: '2', expectedWinRate: 0.45, name: 'Medium-Easy' },
      { id: '3', expectedWinRate: 0.52, name: 'Medium' },
      { id: '4', expectedWinRate: 0.60, name: 'Medium-Hard' },
      { id: '5', expectedWinRate: 0.70, name: 'Hard' }
    ];

    // Mock database calls
    prisma.aiProfile.findMany = jest.fn().mockResolvedValue(mockProfiles);
    prisma.match.update = jest.fn().mockResolvedValue({});
    prisma.aiWinRateStats.findUnique = jest.fn().mockResolvedValue(null);
    prisma.aiWinRateStats.create = jest.fn().mockImplementation(({ data }) => 
      Promise.resolve({ ...data, id: 'stats-1' })
    );
    prisma.aiWinRateStats.update = jest.fn().mockResolvedValue({});
    
    let matches = [];
    let aiWins = 0;
    let currentStreak = 0;
    let maxAbsoluteStreak = 0;

    // Simulate match outcomes
    const simulateMatch = (profile) => {
      const random = Math.random();
      const aiWon = random < profile.expectedWinRate;
      
      if (aiWon) {
        aiWins++;
        currentStreak = currentStreak >= 0 ? currentStreak + 1 : 1;
      } else {
        currentStreak = currentStreak <= 0 ? currentStreak - 1 : -1;
      }
      
      maxAbsoluteStreak = Math.max(maxAbsoluteStreak, Math.abs(currentStreak));
      
      matches.push({
        matchResult: aiWon ? 'AI_WIN' : 'HUMAN_WIN',
        profile: profile.name,
        streak: currentStreak
      });
      
      return aiWon ? 'AI_WIN' : 'HUMAN_WIN';
    };

    // Mock getRecentMatches to return last N matches
    jest.spyOn(controller, 'getRecentMatches').mockImplementation((tier, limit) => {
      return Promise.resolve(matches.slice(-limit));
    });

    // Mock getWinRateStats to calculate from actual matches
    jest.spyOn(controller, 'getWinRateStats').mockImplementation(() => {
      const recentMatches = matches.slice(-100); // Last 100 matches
      const rollingWinRate = recentMatches.length > 0 
        ? recentMatches.filter(m => m.matchResult === 'AI_WIN').length / recentMatches.length
        : 0;
        
      return Promise.resolve({
        totalMatches: matches.length,
        aiWins,
        currentStreak,
        rollingWinRate,
        targetWinRate: 0.52,
        maxStreak: 4
      });
    });

    // Simulate 10,000 matches
    for (let i = 0; i < 10000; i++) {
      const seed = `match-${i}`;
      const selectedProfile = await controller.selectAiProfile(1, seed);
      const result = simulateMatch(selectedProfile);
      
      // Don't actually record to database in test
      // await controller.recordMatchResult(`match-${i}`, selectedProfile.id, 1, result, seed);
    }

    // Analyze results
    const finalWinRate = aiWins / matches.length;
    const last1000WinRate = matches.slice(-1000).filter(m => m.matchResult === 'AI_WIN').length / 1000;
    
    console.log(`\n🎯 AI Win Rate Simulation Results (10,000 matches):`);
    console.log(`   Target Win Rate: 52.0%`);
    console.log(`   Overall Win Rate: ${(finalWinRate * 100).toFixed(1)}%`);
    console.log(`   Last 1,000 matches: ${(last1000WinRate * 100).toFixed(1)}%`);
    console.log(`   Max Absolute Streak: ${maxAbsoluteStreak}`);
    
    // Assertions
    expect(finalWinRate).toBeGreaterThanOrEqual(0.50);
    expect(finalWinRate).toBeLessThanOrEqual(0.54);
    expect(last1000WinRate).toBeGreaterThanOrEqual(0.51);
    expect(last1000WinRate).toBeLessThanOrEqual(0.53);
    expect(maxAbsoluteStreak).toBeLessThanOrEqual(6); // Should rarely exceed max streak
    
  }, 30000); // 30 second timeout for long-running test
});