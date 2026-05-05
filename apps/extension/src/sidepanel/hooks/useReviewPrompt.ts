import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '../stores/chat-store';

interface Stats {
  installedAt: number;
  messageCount: number;
  sessionCount: number;
}

interface ReviewState {
  shownCount: number;
  lastShownAt: number | null;
  rated: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const STATS_KEY = 'ccb-stats';
const REVIEW_KEY = 'ccb-review';

const MIN_DAYS_SINCE_INSTALL = 3;
const MIN_MESSAGES = 10;
const MIN_SESSIONS = 5;

// Days to wait after the previous impression before showing again
const WAIT_DAYS_BY_SHOWN_COUNT: Record<number, number> = {
  1: 2,
  2: 5,
};

const MAX_SHOWS = 3;

function defaultStats(): Stats {
  return { installedAt: Date.now(), messageCount: 0, sessionCount: 0 };
}

function defaultReview(): ReviewState {
  return { shownCount: 0, lastShownAt: null, rated: false };
}

function shouldShowNow(stats: Stats, review: ReviewState, now: number): boolean {
  if (review.rated) return false;
  if (review.shownCount >= MAX_SHOWS) return false;

  const usageOk = stats.messageCount >= MIN_MESSAGES || stats.sessionCount >= MIN_SESSIONS;
  if (!usageOk) return false;

  if (review.shownCount === 0) {
    return now - stats.installedAt >= MIN_DAYS_SINCE_INSTALL * DAY_MS;
  }

  const waitDays = WAIT_DAYS_BY_SHOWN_COUNT[review.shownCount] ?? 0;
  if (review.lastShownAt == null) return true;
  return now - review.lastShownAt >= waitDays * DAY_MS;
}

export function useReviewPrompt(): {
  shouldShow: boolean;
  dismiss: () => void;
  openReview: () => void;
} {
  const [eligible, setEligible] = useState(false);
  const [hiddenInSession, setHiddenInSession] = useState(false);
  const isAgentRunning = useChatStore((s) => s.isAgentRunning);
  const wasAgentRunning = useRef(false);

  useEffect(() => {
    // Trigger eligibility check on the falling edge of isAgentRunning —
    // i.e. the moment Claude finishes a turn. This keeps the prompt tied
    // to a natural pause in the conversation rather than interrupting work.
    const justFinished = wasAgentRunning.current && !isAgentRunning;
    wasAgentRunning.current = isAgentRunning;
    if (!justFinished) return;
    if (eligible) return;

    chrome.storage.local.get([STATS_KEY, REVIEW_KEY], (res) => {
      const stats = (res[STATS_KEY] as Stats | undefined) ?? defaultStats();
      const review = (res[REVIEW_KEY] as ReviewState | undefined) ?? defaultReview();
      if (!shouldShowNow(stats, review, Date.now())) return;

      setEligible(true);
      chrome.storage.local.set({
        [REVIEW_KEY]: {
          ...review,
          shownCount: review.shownCount + 1,
          lastShownAt: Date.now(),
        },
      });
    });
  }, [isAgentRunning, eligible]);

  const dismiss = useCallback(() => {
    setHiddenInSession(true);
  }, []);

  const openReview = useCallback(() => {
    chrome.storage.local.get(REVIEW_KEY, (res) => {
      const prev = (res[REVIEW_KEY] as ReviewState | undefined) ?? defaultReview();
      chrome.storage.local.set({ [REVIEW_KEY]: { ...prev, rated: true } });
    });
    // Hardcoded so clicks work in unpacked / dev installs too.
    // For Chrome Web Store users, chrome.runtime.id matches this ID.
    const url = 'https://chromewebstore.google.com/detail/claude-code-browser/mnibceaaapcppokpnnljohdlmojjgbkf/reviews';
    chrome.tabs.create({ url, active: true });
    setHiddenInSession(true);
  }, []);

  return {
    shouldShow: eligible && !hiddenInSession,
    dismiss,
    openReview,
  };
}
