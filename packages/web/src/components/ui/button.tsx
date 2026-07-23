import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

const base =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0";

const variantClasses: Record<string, string> = {
  default:
    "bg-primary text-primary-foreground shadow-card hover:bg-primary/90 active:scale-[0.98]",
  secondary:
    "bg-secondary text-secondary-foreground hover:bg-accent active:scale-[0.98]",
  outline:
    "border border-border bg-card hover:bg-accent text-foreground active:scale-[0.98]",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  destructive:
    "bg-destructive text-destructive-foreground shadow-card hover:bg-destructive/90 active:scale-[0.98]",
};

const sizeClasses: Record<string, string> = {
  default: "h-9 px-4 py-2",
  sm: "h-8 rounded-md px-3 text-xs",
  icon: "h-9 w-9",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
  size?: "default" | "sm" | "icon";
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(base, variantClasses[variant], sizeClasses[size], className)}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
