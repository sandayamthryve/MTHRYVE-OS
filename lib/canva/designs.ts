import { CANVA_API_BASE } from "@/lib/canva/config";

// Create a design via the Canva Connect API. We make a blank "presentation"
// preset — a sensible social/marketing default — titled after the content item.
// POST https://api.canva.com/rest/v1/designs (scope: design:content:write).
//
// NB: blank designs created through the API are auto-deleted if not edited
// within 7 days (Canva's rule), which is fine here — the edit link is meant to
// be opened and worked on right away.

export interface CreatedCanvaDesign {
  designId: string | null;
  editUrl: string | null;
  viewUrl: string | null;
  thumbnailUrl: string | null;
}

interface CanvaDesignResponse {
  design?: {
    id?: string;
    urls?: { edit_url?: string; view_url?: string };
    thumbnail?: { url?: string };
  };
}

export async function createCanvaDesign(
  accessToken: string,
  title: string
): Promise<CreatedCanvaDesign | null> {
  try {
    const res = await fetch(`${CANVA_API_BASE}/designs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        design_type: { type: "preset", name: "presentation" },
        title: title.slice(0, 255) || "Mthryve OS content",
      }),
    });
    if (!res.ok) {
      console.error("[canva] create design failed", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = (await res.json()) as CanvaDesignResponse;
    const design = data.design;
    if (!design) return null;
    return {
      designId: design.id ?? null,
      editUrl: design.urls?.edit_url ?? null,
      viewUrl: design.urls?.view_url ?? null,
      thumbnailUrl: design.thumbnail?.url ?? null,
    };
  } catch (e) {
    console.error("[canva] create design threw", e);
    return null;
  }
}
