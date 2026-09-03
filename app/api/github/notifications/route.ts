import { agentOwnerSession } from "../../../../lib/agent-server";
import { notificationRecords, privateJson, readJsonObject, setSessionCookie } from "../../../../lib/firebase-server";
import { notificationFailure, sendBudgetNotification } from "../../../../lib/github-notification-server";
import { NotificationError } from "../../../../lib/github-notifications";

export async function GET(request: Request) {
  try {
    const session = await agentOwnerSession(request);
    const configured = Boolean(process.env.GITHUB_NOTIFICATION_REPOSITORY);
    const response = privateJson({ configured, records: configured ? (await notificationRecords(session)).map(({ record }) => record) : [] });
    setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) { return notificationFailure(error); }
}
export async function POST(request: Request) {
  try {
    const session = await agentOwnerSession(request), input = await readJsonObject(request, 512);
    if (Object.keys(input).length !== 1 || typeof input.request_id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(input.request_id)) throw new NotificationError("Specify only the approved request ID.", 400);
    const record = await sendBudgetNotification(request, session, input.request_id);
    const response = privateJson({ record });
    setSessionCookie(response, session.refreshToken);
    return response;
  } catch (error) { return notificationFailure(error); }
}
