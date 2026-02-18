import fs from "fs/promises";
import path from "path";
import process from "process";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const TOKEN_PATH = path.join(process.cwd(), "token.json");
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");

async function loadSavedCredentialsIfExist() {
  try {
    const content = await fs.readFile(TOKEN_PATH, "utf8");
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch {
    return null;
  }
}

async function saveCredentials(client) {
  const content = await fs.readFile(CREDENTIALS_PATH, "utf8");
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;

  const payload = JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });

  await fs.writeFile(TOKEN_PATH, payload, "utf8");
}

async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if (client) {
    // Force a token refresh to verify credentials are valid
    await client.getAccessToken();
    return client;
  }

  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  if (client.credentials?.refresh_token) {
    await saveCredentials(client);
  }
  return client;
}

async function listTodayEvents() {
  const auth = await authorize();
  const calendarClient = google.calendar({ version: "v3", auth });

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const calendarList = await calendarClient.calendarList.list();
  const calendars = calendarList.data.items ?? [];

  const allEvents = [];
  for (const cal of calendars) {
    const res = await calendarClient.events.list({
      calendarId: cal.id,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });
    for (const event of res.data.items ?? []) {
      allEvents.push({ ...event, calendarName: cal.summary });
    }
  }

  allEvents.sort((a, b) => {
    const aTime = a.start?.dateTime || a.start?.date || "";
    const bTime = b.start?.dateTime || b.start?.date || "";
    return aTime.localeCompare(bTime);
  });

  if (allEvents.length === 0) {
    return "No events scheduled for today.";
  }

  const lines = allEvents.map((e) => {
    const time = e.start?.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "All day";
    return `${time} - ${e.summary ?? "(no title)"} [${e.calendarName}]`;
  });

  return `Today's events:\n${lines.join("\n")}`;
}

const server = new McpServer({
  name: "calendar-service",
  version: "1.0.0",
});

server.tool(
  "list_today_events",
  "List today's Google Calendar events",
  async () => {
    const text = await listTodayEvents();
    return { content: [{ type: "text", text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
