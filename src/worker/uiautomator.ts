import { XMLParser } from "fast-xml-parser";
import { Selector } from "../config/actions";
import { AdbClient } from "./adb";

export type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
});

export async function dumpUiHierarchy(adb: AdbClient): Promise<string> {
  const xml = await adb.execOut(
    ["sh", "-c", "uiautomator dump /dev/tty >/dev/null; cat /sdcard/window_dump.xml"],
    10000
  );
  return xml.toString("utf8");
}

export function findSelectorBounds(
  xml: string,
  selector: Selector
): Bounds | null {
  const result = findAnySelectorBounds(xml, [selector]);
  return result ? result.bounds : null;
}

export function boundsCenter(bounds: Bounds): { x: number; y: number } {
  return {
    x: Math.round((bounds.left + bounds.right) / 2),
    y: Math.round((bounds.top + bounds.bottom) / 2),
  };
}

export function findAnySelectorBounds(
  xml: string,
  selectors: Selector[]
): { selector: Selector; bounds: Bounds } | null {
  if (selectors.length === 0) {
    return null;
  }

  const document = parser.parse(xml);
  const nodes: Record<string, unknown>[] = [];
  collectNodes(document, nodes);

  for (const node of nodes) {
    const fields = extractNodeFields(node);
    if (!fields.bounds) {
      continue;
    }

    for (const selector of selectors) {
      if (matchesSelector(fields, selector)) {
        return { selector, bounds: parseBounds(fields.bounds) };
      }
    }
  }

  return null;
}

type NodeFields = {
  text: string;
  resourceId: string;
  contentDesc: string;
  bounds: string | null;
};

function extractNodeFields(node: Record<string, unknown>): NodeFields {
  return {
    text: String(node.text ?? ""),
    resourceId: String(node["resource-id"] ?? ""),
    contentDesc: String(node["content-desc"] ?? ""),
    bounds: typeof node.bounds === "string" ? node.bounds : null,
  };
}

function matchesSelector(fields: NodeFields, selector: Selector): boolean {
  if (selector.text && fields.text !== selector.text) {
    return false;
  }
  if (selector.textContains && !fields.text.includes(selector.textContains)) {
    return false;
  }
  if (selector.resourceId && fields.resourceId !== selector.resourceId) {
    return false;
  }
  if (
    selector.resourceIdContains &&
    !fields.resourceId.includes(selector.resourceIdContains)
  ) {
    return false;
  }
  if (selector.contentDesc && fields.contentDesc !== selector.contentDesc) {
    return false;
  }
  if (
    selector.contentDescContains &&
    !fields.contentDesc.includes(selector.contentDescContains)
  ) {
    return false;
  }
  return true;
}

function collectNodes(value: unknown, nodes: Record<string, unknown>[]): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectNodes(entry, nodes));
    return;
  }

  const record = value as Record<string, unknown>;
  if (record.bounds) {
    nodes.push(record);
  }

  for (const child of Object.values(record)) {
    if (typeof child === "object") {
      collectNodes(child, nodes);
    }
  }
}

function parseBounds(bounds: string): Bounds {
  const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) {
    throw new Error(`Invalid bounds format: ${bounds}`);
  }

  return {
    left: Number.parseInt(match[1], 10),
    top: Number.parseInt(match[2], 10),
    right: Number.parseInt(match[3], 10),
    bottom: Number.parseInt(match[4], 10),
  };
}
