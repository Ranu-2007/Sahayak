import mongoose from "mongoose";

const matchRecommendationSchema = new mongoose.Schema(
  {
    requestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmergencyRequest",
      required: true,
      index: true,
    },
    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Provider",
      required: true,
      index: true,
    },
    eligibilityStatus: {
      type: String,
      enum: ["eligible", "partial", "ineligible", "needs_review"],
      required: true,
      index: true,
    },
    score: { type: Number, min: 0, max: 100 },
    scoreBreakdown: {
      skillCompatibility: { type: Number, min: 0, max: 100 },
      resourceCapacity: { type: Number, min: 0, max: 100 },
      availability: { type: Number, min: 0, max: 100 },
      distance: { type: Number, min: 0, max: 100 },
      reliability: { type: Number, min: 0, max: 100 },
      feedback: { type: Number, min: 0, max: 100 },
      missingComponents: [String],
    },
    explanation: [{ type: String, trim: true, maxlength: 500 }],
    limitations: [{ type: String, trim: true, maxlength: 500 }],
    generatedAt: { type: Date, default: Date.now, index: true },
    availabilitySnapshot: {
      status: String,
      lastUpdated: Date,
      inventory: [
        {
          resourceType: String,
          quantityAvailable: Number,
          unit: String,
          lastUpdated: Date,
        },
      ],
    },
  },
  { timestamps: true },
);

matchRecommendationSchema.index({ requestId: 1, score: -1, generatedAt: -1 });
matchRecommendationSchema.index({ providerId: 1, generatedAt: -1 });

export default mongoose.models.MatchRecommendation ||
  mongoose.model("MatchRecommendation", matchRecommendationSchema);
