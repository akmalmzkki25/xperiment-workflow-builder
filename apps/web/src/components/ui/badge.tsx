import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/cn"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        // The tinted pill. Border and background both derive from `currentColor`, so a
        // caller sets ONE colour — `style={{ color: 'var(--status-failed)' }}` — and the
        // whole chip follows. Every status read-out in the app relies on that; a fixed
        // palette here would need a variant per status and would drift from the tokens.
        tone: "gap-1.5 whitespace-nowrap rounded-full border-current bg-[color-mix(in_srgb,currentColor_9%,transparent)] text-[length:var(--text-small)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

/**
 * A `span`, not shadcn's stock `div`: chips sit inline inside paragraphs and table cells
 * here, and a block element there is invalid HTML that React reports as a hydration error.
 */
function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
