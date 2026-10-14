import { useCallback, useEffect, useRef, useState } from "react";

/** Within this many pixels of the end still counts as reading the latest. */
const THRESHOLD = 48;

/**
 * Keeps a chat scrolled to its newest message. The view opens at the bottom
 * and follows new content while the reader is there; scrolling up stops the
 * follow until they come back down or call `scrollToBottom`.
 *
 * `scroller` goes on the overflow container and `content` on the element
 * inside it whose height grows. A new `key` (a session id) starts at the
 * bottom again.
 */
export function useStickToBottom<
  S extends HTMLElement = HTMLDivElement,
  C extends HTMLElement = HTMLDivElement,
>(key: unknown) {
  const scroller = useRef<S>(null);
  const content = useRef<C>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const element = scroller.current;
    const inner = content.current;
    if (!element || !inner) return;
    pinned.current = true;
    setAtBottom(true);
    const follow = () => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
    };
    const onScroll = () => {
      const near =
        element.scrollHeight - element.scrollTop - element.clientHeight <= THRESHOLD;
      pinned.current = near;
      setAtBottom(near);
    };
    const observer = new ResizeObserver(follow);
    observer.observe(inner);
    observer.observe(element);
    element.addEventListener("scroll", onScroll, { passive: true });
    follow();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", onScroll);
    };
  }, [key]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = true;
    setAtBottom(true);
    element.scrollTo({ top: element.scrollHeight, behavior });
  }, []);

  return { scroller, content, atBottom, scrollToBottom };
}
