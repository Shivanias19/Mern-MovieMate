
const express = require("express");
const Movie = require("../models/Movie");
const MovieCounter = require("../models/MovieCounter");

const router = express.Router();

const genres = [
  "Action", "Comedy", "Drama", "Horror",
  "Sci-Fi", "Romance", "Thriller",
];

const platforms = [
  "Netflix", "Prime Video", "Hotstar",
  "Theatre", "Other",
];

const statuses = ["To Watch", "Watching", "Watched"];

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
    data: null,
  });
}

function validMovieFields(body, partial = false) {
  const fields = ["title", "genre", "releaseYear", "runtime", "platform", "priority"];

  if (!partial) {
    for (const field of fields) {
      if (body[field] === undefined || body[field] === "") {
        return `${field} is required`;
      }
    }
  }

  if (body.title !== undefined &&
      (typeof body.title !== "string" || !body.title.trim())) {
    return "Title cannot be empty";
  }

  if (body.genre !== undefined && !genres.includes(body.genre)) {
    return "Invalid genre";
  }

  if (body.platform !== undefined && !platforms.includes(body.platform)) {
    return "Invalid platform";
  }

  if (body.releaseYear !== undefined &&
      (!Number.isInteger(Number(body.releaseYear)) ||
       Number(body.releaseYear) < 1950 ||
       Number(body.releaseYear) > new Date().getFullYear())) {
    return `Release year must be between 1950 and ${new Date().getFullYear()}`;
  }

  if (body.runtime !== undefined &&
      (!Number.isInteger(Number(body.runtime)) ||
       Number(body.runtime) < 30 || Number(body.runtime) > 300)) {
    return "Runtime must be between 30 and 300 minutes";
  }

  if (body.priority !== undefined &&
      (!Number.isInteger(Number(body.priority)) ||
       Number(body.priority) < 1 || Number(body.priority) > 5)) {
    return "Priority must be between 1 and 5";
  }

  return null;
}

function handleError(res, error) {
  if (error.code === 11000) {
    return sendError(res, 409, "A movie with this title and release year already exists");
  }

  if (error.name === "ValidationError" || error.name === "CastError") {
    return sendError(res, 400, error.message);
  }

  console.error(error);
  return sendError(res, 500, "Internal server error");
}

// GET /api/movies
// Filter, search, sort and paginate on the backend.
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 6;
    const filter = {};

    if (req.query.status) {
      if (!statuses.includes(req.query.status)) {
        return sendError(res, 400, "Invalid status filter");
      }
      filter.status = req.query.status;
    }

    if (req.query.genre) {
      if (!genres.includes(req.query.genre)) {
        return sendError(res, 400, "Invalid genre filter");
      }
      filter.genre = req.query.genre;
    }

    if (req.query.search) {
      const escaped = req.query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.title = { $regex: escaped, $options: "i" };
    }

    const total = await Movie.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    const movies = await Movie.find(filter)
      .collation({ locale: "en", strength: 2 })
      .sort({
        status: 1,
        priority: -1,
        runtime: 1,
        createdAt: -1,
      })
      .skip((page - 1) * limit)
      .limit(limit);

    // Keep To Watch movies first, sorted by priority descending.
    // Then show the other statuses.
    movies.sort((a, b) => {
      if (a.status === "To Watch" && b.status !== "To Watch") return -1;
      if (b.status === "To Watch" && a.status !== "To Watch") return 1;
      if (a.status === "To Watch" && b.status === "To Watch") {
        return b.priority - a.priority || a.runtime - b.runtime;
      }
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    res.json({
      success: true,
      message: "Movies retrieved successfully",
      data: { movies, page, limit, total, totalPages },
    });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/movies/stats
router.get("/stats", async (req, res) => {
  try {
    const statusCounts = await Movie.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const statusTotals = {
      "To Watch": 0,
      Watching: 0,
      Watched: 0,
    };

    statusCounts.forEach(item => {
      statusTotals[item._id] = item.count;
    });

    const watchedStats = await Movie.aggregate([
      { $match: { status: "Watched" } },
      {
        $group: {
          _id: null,
          totalMinutes: { $sum: "$runtime" },
          averageRating: { $avg: "$rating" },
        },
      },
    ]);

    const genreStats = await Movie.aggregate([
      { $match: { status: "Watched" } },
      { $group: { _id: "$genre", count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 1 },
    ]);

    const watched = watchedStats[0] || {
      totalMinutes: 0,
      averageRating: null,
    };

    res.json({
      success: true,
      message: "Statistics retrieved successfully",
      data: {
        statusCounts: statusTotals,
        totalHoursWatched: Math.round((watched.totalMinutes / 60) * 10) / 10,
        averageRating: watched.averageRating == null
          ? null : Math.round(watched.averageRating * 10) / 10,
        topWatchedGenre: genreStats[0]?._id || null,
      },
    });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/movies/watch-next
router.get("/watch-next", async (req, res) => {
  try {
    const movie = await Movie.findOne({ status: "To Watch" })
      .sort({ priority: -1, runtime: 1, createdAt: 1 });

    if (!movie) {
      return sendError(res, 404, "No movies left to watch");
    }

    res.json({
      success: true,
      message: "Your next movie recommendation",
      data: movie,
    });
  } catch (error) {
    handleError(res, error);
  }
});

// GET /api/movies/:id
router.get("/:id", async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      return sendError(res, 400, "Invalid movie ID");
    }

    const movie = await Movie.findById(req.params.id);

    if (!movie) return sendError(res, 404, "Movie not found");

    res.json({ success: true, message: "Movie retrieved", data: movie });
  } catch (error) {
    handleError(res, error);
  }
});

// POST /api/movies
router.post("/", async (req, res) => {
  try {
    const invalid = validMovieFields(req.body);
    if (invalid) return sendError(res, 400, invalid);

    if (
      req.body.movieCode !== undefined ||
      req.body.status !== undefined ||
      req.body.rating !== undefined ||
      req.body.watchedDate !== undefined
    ) {
      return sendError(res, 400, "Movie code, status, rating and watched date are managed by the server");
    }

    const title = req.body.title.trim();
    const releaseYear = Number(req.body.releaseYear);

    const duplicate = await Movie.findOne({
      title,
      releaseYear,
    }).collation({ locale: "en", strength: 2 });

    if (duplicate) {
      return sendError(res, 409, "A movie with this title and release year already exists");
    }

    const counter = await MovieCounter.findOneAndUpdate(
      { _id: releaseYear },
      { $inc: { sequence: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const movieCode = `MV-${releaseYear}-${String(counter.sequence).padStart(3, "0")}`;

    const movie = await Movie.create({
      title,
      genre: req.body.genre,
      releaseYear,
      runtime: Number(req.body.runtime),
      platform: req.body.platform,
      priority: Number(req.body.priority),
      movieCode,
      status: "To Watch",
      rating: null,
      watchedDate: null,
    });

    res.status(201).json({
      success: true,
      message: "Movie added successfully",
      data: movie,
    });
  } catch (error) {
    handleError(res, error);
  }
});

// PUT /api/movies/:id
// Edits permitted movie details and rating on Watched movies.
router.put("/:id", async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      return sendError(res, 400, "Invalid movie ID");
    }

    const movie = await Movie.findById(req.params.id);
    if (!movie) return sendError(res, 404, "Movie not found");

    const allowed = ["title", "genre", "runtime", "platform", "priority"];
    const forbidden = [
      "movieCode", "releaseYear", "status", "watchedDate",
    ];

    if (forbidden.some(field => req.body[field] !== undefined)) {
      return sendError(res, 400, "Movie code, release year, status and watched date cannot be edited here");
    }

    if (Object.keys(req.body).some(key =>
      !allowed.includes(key) && key !== "rating"
    )) {
      return sendError(res, 400, "Unsupported field in request");
    }

    const invalid = validMovieFields(req.body, true);
    if (invalid) return sendError(res, 400, invalid);

    if (req.body.rating !== undefined) {
      if (movie.status !== "Watched") {
        return sendError(res, 400, "Rating can only be set for Watched movies");
      }

      const rating = Number(req.body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
        return sendError(res, 400, "Rating must be an integer from 1 to 10");
      }

      movie.rating = rating;
    }

    if (req.body.title !== undefined) {
      const duplicate = await Movie.findOne({
        _id: { $ne: movie._id },
        title: req.body.title.trim(),
        releaseYear: movie.releaseYear,
      }).collation({ locale: "en", strength: 2 });

      if (duplicate) {
        return sendError(res, 409, "A movie with this title and release year already exists");
      }
    }

    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        movie[field] = field === "title"
          ? req.body[field].trim()
          : ["runtime", "priority"].includes(field)
            ? Number(req.body[field])
            : req.body[field];
      }
    }

    await movie.save();

    res.json({ success: true, message: "Movie updated successfully", data: movie });
  } catch (error) {
    handleError(res, error);
  }
});

// PATCH /api/movies/:id/status
router.patch("/:id/status", async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      return sendError(res, 400, "Invalid movie ID");
    }

    const movie = await Movie.findById(req.params.id);
    if (!movie) return sendError(res, 404, "Movie not found");

    const { status, rating } = req.body;

    if (!statuses.includes(status)) {
      return sendError(res, 400, "Invalid movie status");
    }

    const transitions = {
      "To Watch": ["Watching", "Watched"],
      Watching: ["Watched", "To Watch"],
      Watched: [],
    };

    if (!transitions[movie.status].includes(status)) {
      return sendError(res, 400, `Cannot change status from ${movie.status} to ${status}`);
    }

    if (status === "Watched") {
      const score = Number(rating);
      if (rating === undefined || rating === null || rating === "" ||
          !Number.isInteger(score) || score < 1 || score > 10) {
        return sendError(res, 400, "A rating from 1 to 10 is required to mark a movie Watched");
      }

      movie.rating = score;
      movie.watchedDate = new Date();
    } else {
      if (rating !== undefined) {
        return sendError(res, 400, "Rating is allowed only when marking a movie Watched");
      }
      movie.rating = null;
      movie.watchedDate = null;
    }

    movie.status = status;
    await movie.save();

    res.json({ success: true, message: "Movie status updated", data: movie });
  } catch (error) {
    handleError(res, error);
  }
});

// DELETE /api/movies/:id
router.delete("/:id", async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      return sendError(res, 400, "Invalid movie ID");
    }

    const movie = await Movie.findById(req.params.id);
    if (!movie) return sendError(res, 404, "Movie not found");

    if (movie.status === "Watching") {
      return sendError(res, 400, "Movies currently Watching cannot be deleted");
    }

    await movie.deleteOne();

    res.json({ success: true, message: "Movie deleted successfully", data: movie });
  } catch (error) {
    handleError(res, error);
  }
});

module.exports = router;
