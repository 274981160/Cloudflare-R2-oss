import { DIRECTORY_CONTENT_TYPE, Env } from "../../utils/config";
import { canList, canRead } from "../../utils/auth";
import { listDirectory, statPath } from "../../utils/core";
import {
  ListingEntry,
  renderDirectoryListing,
  serveObject,
} from "../../utils/serve";
import { DavContext } from "./context";

export async function handleRequestGet(context: DavContext): Promise<Response> {
  const { bucket, path, request, env, subject } = context;

  const stat = await statPath(bucket, path);
  if (!stat) return new Response("Not found", { status: 404 });

  if (stat.isDirectory) {
    const listing = await listDirectory(bucket, path);
    const entries: ListingEntry[] = [
      ...listing.folders.map((folder) => ({
        key: folder.key,
        name: folder.name,
        isDirectory: true,
        size: 0,
        uploaded: null as Date | null,
      })),
      ...listing.files.map((file) => ({
        key: file.key,
        name: file.name,
        isDirectory: false,
        size: file.size,
        uploaded: file.uploaded,
      })),
    ].filter((entry) =>
      entry.isDirectory ? canList(subject, entry.key) : canRead(subject, entry.key)
    );

    return renderDirectoryListing(path, entries, { env });
  }

  const response = await serveObject(bucket, path, request, { stat });
  if (!response) return new Response("Not found", { status: 404 });
  return response;
}

export function directoryHeaders(): Headers {
  const headers = new Headers();
  headers.set("Content-Type", DIRECTORY_CONTENT_TYPE);
  return headers;
}
