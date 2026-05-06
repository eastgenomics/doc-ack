import { invoke } from "@forge/bridge";
import { requestConfluence, requestJira } from "@forge/api";
import ForgeUI, {
  render,
  ContentBylineItem,
  Fragment,
  Text,
  Button,
  useProductContext,
  useState,
} from "@forge/ui";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Reader {
  accountId: string;
  displayName: string;
  timestamp: string;
  version: string;
}

interface ConfirmationData {
  readers: Reader[];
}

interface ContentPropertyResponse {
  value: ConfirmationData;
  version: { number: number };
}

interface DocAckKeyResponse {
  value: { issueKey: string };
}

// ─── Confluence helpers ───────────────────────────────────────────────────────

async function getConfirmations(pageId: string): Promise<ConfirmationData> {
  const res = await requestConfluence(
    `/wiki/rest/api/content/${pageId}/property/read-confirmations`
  );
  if (res.status === 404) return { readers: [] };
  const data: ContentPropertyResponse = await res.json();
  return data.value;
}

async function getPropertyVersion(pageId: string): Promise<number> {
  const res = await requestConfluence(
    `/wiki/rest/api/content/${pageId}/property/read-confirmations`
  );
  if (res.status === 404) return 0;
  const data: ContentPropertyResponse = await res.json();
  return data.version.number;
}

async function saveConfirmations(
  pageId: string,
  data: ConfirmationData,
  versionNumber: number
): Promise<void> {
  const isNew = versionNumber === 0;
  const method = isNew ? "POST" : "PUT";
  const url = isNew
    ? `/wiki/rest/api/content/${pageId}/property`
    : `/wiki/rest/api/content/${pageId}/property/read-confirmations`;

  await requestConfluence(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: "read-confirmations",
      value: data,
      version: { number: versionNumber + 1 },
    }),
  });
}

// ─── Jira helper ─────────────────────────────────────────────────────────────

async function closeJiraSubtask(
  pageId: string,
  accountId: string
): Promise<void> {
  // 1. Read the DOCACK parent issue key from the page content property
  const keyRes = await requestConfluence(
    `/wiki/rest/api/content/${pageId}/property/docack-parent-key`
  );
  if (keyRes.status !== 200) return; // No Jira issue linked — skip

  const keyData: DocAckKeyResponse = await keyRes.json();
  const parentKey = keyData.value.issueKey; // e.g. "DOCACK-42"

  // 2. Find this user's open sub-task under the parent
  const jql = encodeURIComponent(
    `project=DOCACK AND parent="${parentKey}" AND assignee="${accountId}" AND status!="Done"`
  );
  const searchRes = await requestJira(
    `/rest/api/3/search?jql=${jql}&maxResults=1`
  );
  const searchData = await searchRes.json();

  if (!searchData.issues?.length) return; // No matching sub-task found

  const subtaskId: string = searchData.issues[0].id;

  // 3. Get the transition ID for "Done"
  const transRes = await requestJira(
    `/rest/api/3/issue/${subtaskId}/transitions`
  );
  const transData = await transRes.json();

  const doneTx = transData.transitions?.find(
    (t: { to: { statusCategory: { key: string } }; id: string }) =>
      t.to.statusCategory.key === "done"
  );
  if (!doneTx) return;

  // 4. Transition the sub-task to Done
  await requestJira(`/rest/api/3/issue/${subtaskId}/transitions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transition: { id: doneTx.id } }),
  });
}

// ─── Main Forge functions (called via invoke) ─────────────────────────────────

export async function fetchConfirmations({
  pageId,
}: {
  pageId: string;
}): Promise<ConfirmationData> {
  return getConfirmations(pageId);
}

export async function addConfirmation({
  pageId,
  accountId,
  displayName,
}: {
  pageId: string;
  accountId: string;
  displayName: string;
}): Promise<ConfirmationData> {
  const data = await getConfirmations(pageId);

  // Idempotency check — do not double-record
  if (data.readers.find((r) => r.accountId === accountId)) {
    return data;
  }

  data.readers.push({
    accountId,
    displayName,
    timestamp: new Date().toISOString(),
    version: "current",
  });

  // Save to Confluence content property with version increment
  const versionNumber = await getPropertyVersion(pageId);
  await saveConfirmations(pageId, data, versionNumber);

  // Transition Jira sub-task to Done (best-effort, non-blocking)
  try {
    await closeJiraSubtask(pageId, accountId);
  } catch (e) {
    // Log but don't fail the confirmation if Jira transition errors
    console.error("Failed to close Jira sub-task:", e);
  }

  return data;
}

// ─── Byline UI ────────────────────────────────────────────────────────────────

const App = () => {
  const context = useProductContext();
  const pageId = context.contentId;
  const accountId = context.accountId;
  const displayName = context.accountId; // displayName is not in context; resolved server-side

  const [data, setData] = useState<ConfirmationData>(
    async () => invoke<ConfirmationData>("fetchConfirmations", { pageId })
  );

  const alreadyConfirmed = data.readers.find((r) => r.accountId === accountId);
  const count = data.readers.length;

  const confirm = async () => {
    const updated = await invoke<ConfirmationData>("addConfirmation", {
      pageId,
      accountId,
      displayName,
    });
    setData(updated);
  };

  return (
    <Fragment>
      <Text>
        {alreadyConfirmed
          ? `✅ You confirmed on ${new Date(
              alreadyConfirmed.timestamp
            ).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}`
          : `📄 ${count} confirmed`}
      </Text>
      {!alreadyConfirmed && (
        <Button
          text="✅ I have read this document"
          onClick={confirm}
        />
      )}
    </Fragment>
  );
};

export const handler = render(
  <ContentBylineItem>
    <App />
  </ContentBylineItem>
);
