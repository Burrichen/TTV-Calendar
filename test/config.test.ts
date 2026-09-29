import { describe, expect, it } from 'vitest';

import { ConfigurationError, loadConfig } from '../src/config/env.ts';

/**
 * Configuration is the first thing a workflow run touches, so its failures are the
 * cheapest ones to have. These tests pin the two properties that matter: sensible
 * defaults, and a fatal, *complete* error when something is missing.
 */

const valid = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_CHANNEL_ID: 'C0123456789',
  STATE_API_URL: 'https://ttv-calendar-bot.example.workers.dev',
  INTERNAL_API_SECRET: 'x'.repeat(32),
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig(valid);

    expect(config.timezone).toBe('Europe/London');
    expect(config.summaryHour).toBe(8);
    expect(config.logLevel).toBe('info');
    expect(config.runTimeoutSeconds).toBe(240);
    expect(config.tennisTv.siteBaseUrl).toBe('https://www.tennistv.com');
    expect(config.tennisTv.apiBaseUrl).toBe('https://api.tennistv.com');
    expect(config.tennisTv.accountId).toBe('35');
    expect(config.tennisTv.provider).toBe('live');
    expect(config.monitor.scheduleSlipMinutes).toBe(15);
    expect(config.retention.stateDays).toBe(30);
    expect(config.slack.dryRun).toBe(false);
  });

  it('carries the state API through, since a command is useless without it', () => {
    const config = loadConfig(valid);

    expect(config.stateApi.baseUrl).toBe('https://ttv-calendar-bot.example.workers.dev');
    expect(config.stateApi.secret).toBe('x'.repeat(32));
  });

  it('coerces numeric settings from strings', () => {
    const config = loadConfig({
      ...valid,
      SUMMARY_HOUR: '9',
      MONITOR_SCHEDULE_SLIP_MINUTES: '30',
      RUN_TIMEOUT_SECONDS: '600',
    });

    expect(config.summaryHour).toBe(9);
    expect(config.monitor.scheduleSlipMinutes).toBe(30);
    expect(config.runTimeoutSeconds).toBe(600);
  });

  it.each(['true', '1'])('treats %s as a true boolean', (value) => {
    expect(loadConfig({ ...valid, SLACK_DRY_RUN: value }).slack.dryRun).toBe(true);
  });

  it.each(['false', '0'])('treats %s as a false boolean', (value) => {
    expect(loadConfig({ ...valid, SLACK_DRY_RUN: value }).slack.dryRun).toBe(false);
  });

  it('freezes the result so nothing can mutate configuration mid-run', () => {
    const config = loadConfig(valid);

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.slack)).toBe(true);
    expect(Object.isFrozen(config.stateApi)).toBe(true);
    expect(Object.isFrozen(config.tennisTv)).toBe(true);
    expect(Object.isFrozen(config.monitor)).toBe(true);
  });

  describe('fails fast', () => {
    it('rejects a fixed-offset timezone', () => {
      // PROJECT_SPEC.md §7: an IANA zone, never a hard-coded offset. This is the check
      // that stops anyone "fixing" BST by writing UTC+1.
      expect(() => loadConfig({ ...valid, APP_TIMEZONE: 'UTC+1' })).toThrow(/IANA time zone/);
    });

    it('rejects a malformed bot token', () => {
      expect(() => loadConfig({ ...valid, SLACK_BOT_TOKEN: 'nope' })).toThrow(ConfigurationError);
    });

    it('rejects a state API URL that is not a URL', () => {
      expect(() => loadConfig({ ...valid, STATE_API_URL: 'workers.dev' })).toThrow(
        ConfigurationError,
      );
    });

    it('rejects a state API secret short enough to be guessable', () => {
      expect(() => loadConfig({ ...valid, INTERNAL_API_SECRET: 'short' })).toThrow(
        ConfigurationError,
      );
    });

    it('rejects an unknown provider mode', () => {
      expect(() => loadConfig({ ...valid, TENNISTV_PROVIDER: 'scraper' })).toThrow(
        ConfigurationError,
      );
    });

    it('rejects an out-of-range run timeout', () => {
      expect(() => loadConfig({ ...valid, RUN_TIMEOUT_SECONDS: '99999' })).toThrow(
        ConfigurationError,
      );
    });

    it('reports every problem at once rather than one per workflow run', () => {
      let message = '';
      try {
        loadConfig({});
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain('SLACK_BOT_TOKEN');
      expect(message).toContain('SLACK_CHANNEL_ID');
      expect(message).toContain('STATE_API_URL');
      expect(message).toContain('INTERNAL_API_SECRET');
      expect(message).toContain('.env.example');
    });

    it('names variables but never echoes their values', () => {
      // A build log is a public artefact. A rejected token must not be reprinted into
      // one, so the wrong-prefix case is used here precisely because it *does* throw.
      let message = '';
      try {
        loadConfig({ ...valid, SLACK_BOT_TOKEN: 'xoxc-leaked-secret-material' });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain('SLACK_BOT_TOKEN');
      expect(message).not.toContain('leaked-secret-material');
    });

    it('throws a ConfigurationError, so a command can report it before a logger exists', () => {
      expect(() => loadConfig({})).toThrow(ConfigurationError);
    });
  });
});

describe('empty environment variables', () => {
  /**
   * GitHub Actions renders an unset repository variable, and an absent
   * `workflow_dispatch` input, as an empty string rather than omitting it. Every
   * optional variable in the workflows is passed unconditionally, so if blanks were not
   * treated as absent, leaving one unconfigured would fail every scheduled run.
   */
  it('falls back to defaults rather than failing validation', () => {
    const config = loadConfig({
      ...valid,
      APP_TIMEZONE: '',
      TENNISTV_BASE_URL: '',
      LOG_LEVEL: '',
      SLACK_DRY_RUN: '',
      SUMMARY_HOUR: '',
    });

    expect(config.timezone).toBe('Europe/London');
    expect(config.tennisTv.siteBaseUrl).toBe('https://www.tennistv.com');
    expect(config.logLevel).toBe('info');
    expect(config.slack.dryRun).toBe(false);
    expect(config.summaryHour).toBe(8);
  });

  it('still rejects a required variable that is blank', () => {
    // Blank means "not configured", which for a required value is an error, not a
    // default.
    expect(() => loadConfig({ ...valid, SLACK_CHANNEL_ID: '   ' })).toThrow(ConfigurationError);
  });
});
