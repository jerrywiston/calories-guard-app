const HISTORY_FILENAME = /^(\d{4}-\d{2}-\d{2})\.json$/;

function isDirectoryAlreadyExistsError(error) {
  return error?.code === "OS-PLUG-FILE-0010"
    || /already exists(?:,|\s).*cannot be overwritten/i.test(String(error?.message || error || ""));
}

function isFileMissingError(error) {
  return error?.code === "OS-PLUG-FILE-0008"
    || /(?:file|entry).*(?:does not exist|not found)/i.test(String(error?.message || error || ""));
}

function datesFromListing(listing) {
  return (Array.isArray(listing?.files) ? listing.files : [])
    .map(file => String(file?.name || "").match(HISTORY_FILENAME)?.[1])
    .filter(Boolean)
    .sort()
    .reverse();
}

export async function listDeviceHistoryDates({ filesystem, directory, path = "history" }) {
  let listing;
  try {
    listing = await filesystem.readdir({ path, directory });
  } catch {
    try {
      await filesystem.mkdir({ path, directory, recursive: true });
    } catch (error) {
      // Android reports an error when another call has already created the
      // directory. That state is safe, so read it instead of showing an error.
      if (!isDirectoryAlreadyExistsError(error)) throw error;
    }
    listing = await filesystem.readdir({ path, directory });
  }
  return datesFromListing(listing);
}

export async function deleteDeviceHistoryRecord({ filesystem, directory, date, path = "history" }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new Error("歷史紀錄日期格式錯誤。");
  try {
    await filesystem.deleteFile({ path: `${path}/${date}.json`, directory });
    return true;
  } catch (error) {
    if (isFileMissingError(error)) return false;
    throw error;
  }
}
