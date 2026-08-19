import { ApiError } from "./api";

const messages: Record<string, string> = {
  // --- Publicering / version ---
  flow_not_published: "Det här flödet är inte publicerat och kan inte köras.",
  flow_definition_checksum_mismatch:
    "Flödet har ändrats sedan den publicerade versionen sparades. Publicera om flödet i Eneo och försök igen.",
  not_found: "Flödet eller körningen finns inte längre.",
  // Den publicerade flödesdefinitionen validerar inte mot nuvarande Eneo-version.
  // Kan inte lösas i appen — flödet behöver rättas och publiceras om i Eneo.
  flow_definition_invalid:
    "Flödets publicerade definition är inte giltig i den här Eneo-versionen. Öppna flödet i Eneo, rätta steget som pekas ut och publicera om.",
  flow_definition_steps_invalid:
    "Ett av flödets steg är inte giltigt i den här Eneo-versionen. Öppna flödet i Eneo, rätta steget som pekas ut och publicera om.",
  flow_definition_schema_version_unsupported:
    "Flödet publicerades med en äldre definitionsversion som inte längre stöds. Publicera om flödet i Eneo.",
  flow_definition_schema_version_missing:
    "Flödet publicerades med en äldre definitionsversion som inte längre stöds. Publicera om flödet i Eneo.",
  flow_definition_no_executable_steps:
    "Flödet har inga körbara steg i den publicerade versionen.",
  flow_assistant_snapshot_drift:
    "Assistenten i ett av stegen har ändrats sedan flödet publicerades. Publicera om flödet i Eneo.",
  flow_unsupported_output_type:
    "Flödets output-typ stöds inte längre. Justera sista steget i Eneo och publicera om.",
  flow_unsupported_output_mode:
    "Flödets output-läge stöds inte längre. Justera sista steget i Eneo och publicera om.",

  // --- Filuppladdning (runtime-files) ---
  flow_run_unknown_step_input:
    "Flödet har ändrats sedan sidan laddades. Ladda om sidan och försök igen.",
  flow_run_runtime_input_disabled:
    "Det här flödet tar inte emot filuppladdning.",
  flow_runtime_file_empty:
    "Ljudfilen blev tom. Spela in på nytt och kontrollera att mikrofonen fungerar.",
  file_too_large: "Filen är för stor.",
  unsupported_media_type:
    "Filtypen stöds inte av det här flödet. Kontrollera vilka format flödet accepterar.",
  runtime_input_consumed:
    "Den uppladdade filen är redan använd i en körning. Ladda upp den på nytt.",

  // --- Körning ---
  flow_run_concurrency_limit_reached:
    "För många samtidiga körningar pågår. Vänta lite och försök igen.",
  flow_run_idempotency_conflict: "Idempotency-konflikt. Försök igen.",
  flow_run_invalid_idempotency_key:
    "Ogiltig idempotency-nyckel. Ladda om sidan och försök igen.",
  flow_run_top_level_file_ids_not_supported:
    "Appen skickade filen i ett format som Eneo inte längre stöder. Uppdatera appen.",

  // --- Granskning (human-in-the-loop) ---
  flow_review_stale_revision:
    "Granskningen har uppdaterats av någon annan. Ladda om och försök igen.",
  flow_review_not_active: "Granskningen är inte längre aktiv.",
  flow_review_expired: "Granskningen har gått ut och kan inte slutföras.",
  flow_review_rejected: "Granskningen har redan avvisats.",
  flow_review_already_resumed: "Körningen har redan återupptagits.",
  flow_review_edit_not_allowed:
    "Det här granskningssteget går inte att redigera.",
  flow_review_edit_file_backed_unsupported:
    "Resultatet ligger i en genererad fil och kan inte redigeras här.",
  flow_review_edit_output_too_large:
    "Den redigerade texten är för lång för att sparas.",
  flow_review_reject_reason_required: "Ange en orsak för att avvisa.",
  typed_io_contract_violation:
    "Det redigerade värdet matchar inte flödets förväntade format.",

  // --- Behörighet ---
  insufficient_scope:
    "API-nyckeln har fel scope för det här flödet eller spacet.",
  insufficient_space_permission:
    "API-nyckeln saknar behörighet till det här spacet.",
  insufficient_tenant_permission:
    "API-nyckeln saknar behörighet i den här organisationen.",
  authentication_error:
    "API-nyckeln är ogiltig eller har återkallats. Uppdatera nyckeln i konfigurationen.",
  invalid_api_key:
    "API-nyckeln är ogiltig eller har återkallats. Uppdatera nyckeln i konfigurationen.",

  // --- Vår egen proxy ---
  upstream_unreachable:
    "Uppladdningen tog för lång tid eller avbröts. Prova att starta om körningen, eller dela inspelningen i kortare delar.",
  upstream_upload_timeout:
    "Uppladdningen tog för lång tid. Prova igen, eller dela inspelningen i kortare delar.",
};

// Texten på en TypeError från fetch när nätverket bryts ("Failed to fetch" i
// Chromium, "NetworkError when attempting to fetch resource." i Firefox, etc).
function looksLikeNetworkError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("network") ||
    m.includes("load failed")
  );
}

export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code && messages[err.code]) return messages[err.code];
    if (err.status === 401) {
      // Vår egen "Not authenticated" från backend saknar `code`-fält.
      // Eneo:s 401 har alltid en `code` (invalid_api_key, etc).
      if (!err.code) return "Sessionen har gått ut. Logga in igen.";
      return err.message || "Anropet nekades av Eneo.";
    }
    if (err.status === 403) {
      return err.message || "Behörighet saknas.";
    }
    if (err.status === 413) return "Filen är för stor.";
    if (err.status === 415) return "Filtypen stöds inte.";
    if (err.status === 502 || err.status === 503 || err.status === 504) {
      return "Servern kunde inte nås just nu. Försök igen om en stund.";
    }
    // Okänd kod: visa Eneos text men behåll koden så felet går att felsöka.
    if (err.message && err.code) return `${err.message} (${err.code})`;
    return err.message || `HTTP ${err.status}`;
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return "Uppladdningen avbröts (tog för lång tid eller stannade upp).";
    }
    if (looksLikeNetworkError(err.message)) {
      return "Anslutningen avbröts. Kontrollera nätverket och försök igen.";
    }
    return err.message;
  }
  return "Ett okänt fel uppstod.";
}
