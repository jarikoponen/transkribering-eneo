"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ChevronRight,
  FileText,
  Phone,
  Users,
  User,
  MessageSquare,
  Mic,
} from "lucide-react";
import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import {
  firstInputFormat,
  getConfig,
  getRunContract,
  getSpace,
  listFlows,
  listSpaces,
  type AppConfig,
  type FlowSparsePublic,
  type SpaceSparse,
} from "@/lib/api";
import { friendlyError } from "@/lib/errors";

export default function FlowsPage() {
  return (
    <AuthGate>
      <FlowsListPage />
    </AuthGate>
  );
}

interface SpaceFlowsData {
  spaceId: string;
  space: SpaceSparse | null;
  flows: FlowSparsePublic[] | null;
  error: string | null;
  loading: boolean;
}

function isFlowPublished(flow: FlowSparsePublic): boolean {
  return (
    flow.is_published === true ||
    (flow.published_version != null && flow.published_version > 0)
  );
}

// Hämtar input_format för första steget per publicerat flöde (via run-kontraktet)
// så vi kan välja en talande ikon: mikrofon för ljud, dokument för filuppladdning.
function useFlowInputFormats(
  flows: FlowSparsePublic[] | null,
  spaceId: string,
): Record<string, string> {
  const [formats, setFormats] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!flows || !spaceId) return;
    let cancelled = false;
    const published = flows.filter(isFlowPublished);
    Promise.all(
      published.map(async (f) => {
        try {
          const contract = await getRunContract(f.id, { spaceId });
          const fmt = firstInputFormat(contract);
          return fmt ? ([f.id, fmt] as const) : null;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const e of entries) if (e) map[e[0]] = e[1];
      setFormats(map);
    });
    return () => {
      cancelled = true;
    };
  }, [flows, spaceId]);

  return formats;
}

function FlowsListPage() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [allSpaces, setAllSpaces] = useState<SpaceSparse[] | null>(null);
  const [spaceId, setSpaceId] = useState<string>("");
  const [flows, setFlows] = useState<FlowSparsePublic[] | null>(null);
  const [loadingFlows, setLoadingFlows] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Flerspace-läge: en datapost per konfigurerad space.
  const [sections, setSections] = useState<SpaceFlowsData[] | null>(null);

  useEffect(() => {
    getConfig()
      .then((cfg) => {
        setConfig(cfg);
        const ids = cfg.demo_space_ids ?? [];

        if (ids.length >= 1) {
          // Flerspace-läget: hämta metadata + flöden per space parallellt med rätt key.
          const init: SpaceFlowsData[] = ids.map((id) => ({
            spaceId: id,
            space: null,
            flows: null,
            error: null,
            loading: true,
          }));
          setSections(init);

          ids.forEach((id, idx) => {
            Promise.all([
              // Eneo:s scope:ade API-keys ser inte sina spaces via /spaces/-listning,
              // så vi hämtar direkt på /spaces/{id}/ istället.
              getSpace(id).catch(() => null),
              listFlows(id, 50, 0, { spaceId: id }).then(
                (res) => res.items ?? [],
              ),
            ])
              .then(([space, flowList]) => {
                setSections((prev) =>
                  prev
                    ? prev.map((s, i) =>
                        i === idx
                          ? { ...s, space, flows: flowList, loading: false }
                          : s,
                      )
                    : prev,
                );
              })
              .catch((err) => {
                setSections((prev) =>
                  prev
                    ? prev.map((s, i) =>
                        i === idx
                          ? {
                              ...s,
                              error: friendlyError(err),
                              loading: false,
                            }
                          : s,
                      )
                    : prev,
                );
              });
          });
          return;
        }

        // Fallback: gamla en-space-läget med spacev väljare.
        if (cfg.demo_space_id) {
          setSpaceId(cfg.demo_space_id);
          return;
        }
        return listSpaces().then((res) => {
          const items = res.items ?? [];
          setAllSpaces(items);
          if (items.length > 0) setSpaceId(items[0].id);
        });
      })
      .catch((err) => setError(friendlyError(err)));
  }, []);

  useEffect(() => {
    if (!spaceId || sections) return;
    setLoadingFlows(true);
    setFlows(null);
    setError(null);
    listFlows(spaceId)
      .then((res) => setFlows(res.items ?? []))
      .catch((err) => setError(friendlyError(err)))
      .finally(() => setLoadingFlows(false));
  }, [spaceId, sections]);

  const hardcodedSpace = !!config?.demo_space_id;
  // Endast aktivt i fallback-läget (en space utan sektioner).
  const fallbackInputFormats = useFlowInputFormats(flows, spaceId);
  const today = new Date().toLocaleDateString("sv-SE", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <>
      <AppHeader />

      <section className="px-6 md:px-8 pt-4 pb-10 md:pt-8 md:pb-14">
        <div className="eyebrow mb-4">
          {today.charAt(0).toUpperCase() + today.slice(1)}
        </div>
        <h1 className="text-[30px] md:text-[40px] lg:text-[44px] font-semibold leading-[1.05] tracking-[-0.025em]">
          Vad ska vi <span className="accent-em">spela in</span>?
        </h1>
      </section>

      {sections ? (
        sections.map((sec, idx) => (
          <SpaceFlowsSection
            key={sec.spaceId}
            section={sec}
            fallbackTitle={`Space ${idx + 1}`}
          />
        ))
      ) : (
        <>
          {!hardcodedSpace && allSpaces && allSpaces.length > 1 && (
            <div className="mx-4 mb-3 paper-card p-4">
              <label htmlFor="space-select" className="eyebrow-sm block mb-2">
                Space
              </label>
              <select
                id="space-select"
                value={spaceId}
                onChange={(e) => setSpaceId(e.target.value)}
                className="w-full bg-transparent border-0 p-0 text-[16px] font-medium text-ink outline-none cursor-pointer"
              >
                {allSpaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.personal ? " (personlig)" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="px-6 md:px-8 pb-2 flex items-center justify-between eyebrow">
            <span>Samtalstyper</span>
            {flows && (
              <span>
                {flows.length} {flows.length === 1 ? "flöde" : "flöden"}
              </span>
            )}
          </div>

          <section className="px-4 md:px-6 pb-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 md:gap-3">
            {error && (
              <p className="px-2 text-sm text-accent" role="alert">
                {error}
              </p>
            )}

            {loadingFlows && <FlowRowSkeleton />}

            {flows && flows.length === 0 && !loadingFlows && (
              <p className="px-2 py-6 text-ink-soft text-sm">
                Inga flöden i det här space:t än.
              </p>
            )}

            {flows?.map((flow, idx) => (
              <FlowRow
                key={flow.id}
                flow={flow}
                spaceId={spaceId}
                isPublished={isFlowPublished(flow)}
                iconIndex={idx}
                inputFormat={fallbackInputFormats[flow.id]}
              />
            ))}
          </section>
        </>
      )}
    </>
  );
}

function SpaceFlowsSection({
  section,
  fallbackTitle,
}: {
  section: SpaceFlowsData;
  fallbackTitle: string;
}) {
  const title = section.space?.name ?? fallbackTitle;
  const description = section.space?.description?.trim();
  const inputFormats = useFlowInputFormats(section.flows, section.spaceId);

  return (
    <section className="mx-4 md:mx-6 mb-7 md:mb-10 rounded-3xl bg-paper border border-rule-soft shadow-[0_6px_28px_-16px_rgba(0,0,0,0.12)] px-7 md:px-11 pt-8 md:pt-11 pb-8 md:pb-11">
      <div className="px-1 pb-4">
        <h2 className="text-[20px] md:text-[24px] font-bold tracking-[-0.015em] leading-tight text-ink">
          {title}
        </h2>
      </div>

      {description && (
        <p className="px-1 pb-6 text-[13px] text-ink-soft leading-relaxed max-w-4xl">
          {description}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5 md:gap-4">
        {section.error && (
          <p className="px-2 text-sm text-accent" role="alert">
            {section.error}
          </p>
        )}

        {section.loading && <FlowRowSkeleton />}

        {section.flows && section.flows.length === 0 && !section.loading && (
          <p className="px-2 py-6 text-ink-soft text-sm">
            Inga flöden i det här space:t än.
          </p>
        )}

        {section.flows?.map((flow, idx) => (
          <FlowRow
            key={flow.id}
            flow={flow}
            spaceId={section.spaceId}
            isPublished={isFlowPublished(flow)}
            iconIndex={idx}
            inputFormat={inputFormats[flow.id]}
          />
        ))}
      </div>
    </section>
  );
}

const ICONS = [Phone, Users, User, MessageSquare, Mic];
const FILE_INPUT_FORMATS = ["document", "file", "image", "pdf"];

function iconForFlow(
  inputFormat: string | null | undefined,
  iconIndex: number,
) {
  if (inputFormat === "audio") return Mic;
  if (inputFormat && FILE_INPUT_FORMATS.includes(inputFormat)) return FileText;
  // Inget fil-/ljudsteg först (t.ex. textinput) → behåll den dekorativa ikonen.
  return ICONS[iconIndex % ICONS.length];
}

function FlowRow({
  flow,
  spaceId,
  isPublished,
  iconIndex,
  inputFormat,
}: {
  flow: FlowSparsePublic;
  spaceId: string;
  isPublished: boolean;
  iconIndex: number;
  inputFormat?: string | null;
}) {
  const href = spaceId
    ? `/flows/${flow.id}?s=${spaceId}`
    : `/flows/${flow.id}`;
  const Wrapper = isPublished ? Link : "div";
  const props = isPublished ? { href } : ({} as never);
  const Icon = iconForFlow(inputFormat, iconIndex);

  const desc =
    flow.description ||
    (isPublished
      ? `Publicerad v${flow.published_version ?? "?"}`
      : "Ej publicerad");

  return (
    <Wrapper
      {...props}
      className={[
        "flex items-center gap-3.5 rounded-2xl border bg-bg px-4 py-4 md:py-[18px] transition-all",
        isPublished
          ? "cursor-pointer border-rule-soft hover:border-ink active:scale-[0.98]"
          : "border-rule-soft opacity-60",
      ].join(" ")}
    >
      <div className="grid place-items-center h-[38px] w-[38px] rounded-[10px] shrink-0 bg-accent-soft text-accent">
        <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[16px] font-semibold leading-tight tracking-[-0.01em] truncate">
          {flow.name}
        </div>
        <div className="text-[12px] text-ink-mute mt-0.5 leading-tight truncate">
          {desc}
        </div>
      </div>
      {isPublished && (
        <ChevronRight
          className="h-3.5 w-3.5 text-ink-mute shrink-0"
          strokeWidth={2}
        />
      )}
    </Wrapper>
  );
}

function FlowRowSkeleton() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="flex items-center gap-3.5 rounded-2xl border border-rule-soft bg-paper px-4 py-3.5 animate-pulse"
        >
          <div className="h-[38px] w-[38px] rounded-[10px] bg-bg-2" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-2/3 bg-bg-2 rounded" />
            <div className="h-3 w-1/3 bg-bg-2 rounded" />
          </div>
        </div>
      ))}
    </>
  );
}
