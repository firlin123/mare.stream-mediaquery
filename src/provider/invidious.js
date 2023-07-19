import { request } from '../request';
import Media from '../media';

const LOGGER = require('@calzoneman/jsli')('mediaquery/youtube');
const PLAYLIST_ITEM_LIMIT = 2000;

let INSTANCE = null;
let USER_AGENT = null;
let CACHE = null;

/*
 * Retrieve metadata for a single YouTube video.
 *
 * Returns a Media object
 */
export async function lookup(id) {
    let cached = null;
    if (CACHE !== null) {
        try {
            cached = await CACHE.get(id, 'iv');
        } catch (error) {
            LOGGER.error('Error retrieving cached metadata for iv:%s - %s', id, error.stack);
        }
    }

    let media = await _lookupInternal(id, cached);
    if (CACHE !== null) {
        try {
            await CACHE.put(media);
        } catch (error) {
            LOGGER.error('Error updating cached metadata for iv:%s - %s', id, error.stack);
        }
    }

    return media;
}

async function ivRequest(url, headers = {}) {
    if (!headers) headers = {};
    if (USER_AGENT) {
        headers["User-Agent"] = USER_AGENT;
    }
    const res = await request(url, { headers });
    switch (res.statusCode) {
        case 429:
            LOGGER.error('Error calling Invidious API: Too Many Requests');
            throw new Error(`Error calling Invidious API (instance: ${url.origin}). Try again later or set different instance.`);
        case 404:
            LOGGER.error('Error video or playlist is unavailable.');
            throw new Error('Video or playlist with this id is unavailable.');
        case 500:
            LOGGER.error('Error video or playlist is private.');
            throw new Error('Video or playlist with this id is private.');
        default:
            if (res.statusCode !== 200) {
                throw new Error(`Error calling Invidious API (instance: ${url.origin}): HTTP ${res.statusCode}`);
            }
            break;
    }

    try {
        return JSON.parse(res.data);
    } catch (error) {
        LOGGER.error(
            'Invidious API returned non-JSON response: %s',
            String(res.data).substring(0, 1000)
        );
        throw new Error(`Error calling Invidious API (instance: ${url.origin}): could not decode response as JSON`);
    }
}

function _lookupInternal(id, cached) {
    if (cached) return cached;
    if (!INSTANCE) {
        return Promise.reject(new Error('Instance is not set for Invidious'));
    }

    const url = new URL(`/api/v1/videos/${id}`, INSTANCE);
    url.search = new URLSearchParams({
        fields: 'videoId,title,lengthSeconds,videoThumbnails,error'
    });

    return ivRequest(url).then(res => {
        return videoToMedia(res);
    });
}

function videoToMedia(video) {
    if (!video) {
        throw new Error('Video is null');
    }
    if (video.error) {
        throw new Error('Video contains error: ' + video.error);
    }

    const data = {
        id: video.videoId,
        type: 'invidious',
        title: video.title,
        duration: video.lengthSeconds,
        meta: {
            thumbnail: `https://img.youtube.com/vi/${video.videoId}/0.jpg`
        }
    };

    if (video.videoThumbnails.length) {
        let maxWidth = 0;
        let maxWidthI = 0;
        video.videoThumbnails.forEach((t, i) => { if (t.width > maxWidth) { maxWidth = t.width; maxWidthI = i; } });
        data.meta.thumbnail = video.videoThumbnails[maxWidthI].url;
    }

    return new Media(data);
}

/*
 * Search for YouTube videos.  Optionally provide the ID of the page of results
 * to retrieve.
 *
 * Returns { nextPage: (string: next page number), results: (list of Media) }
 */
export function search(query, nextPage = false) {
    if (!INSTANCE) {
        return Promise.reject(new Error('Instance is not set for Invidious'));
    }

    const url = new URL('/api/v1/search', INSTANCE);
    url.search = new URLSearchParams({
        q: query.replace(/%20/g, '+'),
        page: nextPage ? nextPage : 1,
        type: 'video',

    });

    return ivRequest(url).then(result => {
        let nextPageNumber = nextPage == false ? 2 : nextPage + 1;
        if (!result.length) nextPageNumber = false;

        return {
            nextPage: nextPageNumber,
            results: result.map(video => videoToMedia(video))
        };
    });
}

/*
 * Retrieve metadata for all items on a YouTube playlist.  For playlists longer
 * than approx. 200 videos, it recurses to retrieve every page of results.
 *
 * Returns a list of Media objects
 */
export async function lookupPlaylist(id) {
    if (!INSTANCE) {
        return Promise.reject(new Error('Instance is not set for Invidious'));
    }

    LOGGER.info('Looking up YouTube playlist %s', id);

    let page = 1;
    const url = new URL(`/api/v1/playlists/${id}`, INSTANCE);
    url.search = new URLSearchParams({ page });

    let res = await ivRequest(url);
    if (res.videoCount > PLAYLIST_ITEM_LIMIT) {
        LOGGER.warn('Rejecting YouTube Playlist %s for length %d', id, res.videoCount);
        throw new Error(`YouTube Playlist is too long to queue (limit ${PLAYLIST_ITEM_LIMIT}).`);
    }
    const resultsMap = {};
    res.videos.forEach(video => resultsMap[video.videoId] = video);
    let resultsLength = Object.keys(resultsMap).length;
    while (res.videos.length && resultsLength < PLAYLIST_ITEM_LIMIT && resultsLength != res.videoCount) {
        page++;
        LOGGER.info('Fetching next page of playlist %s, have %d items so far', id, resultsLength);
        url.search = new URLSearchParams({ page });
        res = await ivRequest(url);
        res.videos.forEach(video => resultsMap[video.videoId] = video);
        resultsLength = Object.keys(resultsMap).length;
    }

    if (resultsLength >= PLAYLIST_ITEM_LIMIT) {
        LOGGER.warn('Length check failed for playlist %s: %d', id, resultsLength);
        throw new Error(`YouTube Playlist is too long to queue (limit ${PLAYLIST_ITEM_LIMIT}).`);
    }

    return Object.keys(resultsMap).filter(key => resultsMap[key].lengthSeconds).map(key => videoToMedia(resultsMap[key]));
}

export function setInstance(instance) {
    INSTANCE = instance;
}

export function setUserAgent(userAgent) {
    USER_AGENT = userAgent;
}

export function setCache(cache) {
    CACHE = cache;
}
