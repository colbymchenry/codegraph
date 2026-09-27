# Module header is not the module docstring.
(u"Ledger module " r"documentation.")

# Legacy reconciliation path.
@decorator
async def reconcile_ledger():
    # A comment before the docstring is allowed.
    """Settle the nightly discrepancy with the bank."""
    return 1

# Settle the nightly discrepancy with the bank.
def audit_ledger():
    return 1

# Ledger class comment.
@decorator
class Ledger:
    # Class body comment.
    '''Post entries.

        Preserve relative indentation:
            details here.
    '''

    # Method comment.
    @staticmethod
    async def settle():
        # Method body comment.
        (U"Settle "  # Between concatenated strings.
         R"the ledger.")
        return 1

def raw_doc():
    R'''Raw \d+ expression.'''
    return 1

def empty_concat():
    "" "Kept prose." ""
    return 1

def empty_doc():
    ""
    return 1

def bytes_doc():
    b"Not documentation."
    return 1

def raw_bytes_doc():
    BR"Not documentation."
    return 1

def formatted_doc():
    F"Not documentation."
    return 1

def interpolated_doc():
    rf"Not {documentation}."
    return 1

def concatenated_bytes():
    b"Not " b"documentation."
    return 1

def concatenated_format():
    "Not " f"documentation."
    return 1

def late_string():
    value = 1
    "Not documentation."
    return value

def computed_string():
    "Not " + "documentation."
    return 1

def tuple_string():
    ("Not documentation.",)
    return 1

def bare_tuple():
    "Not documentation.", "Also not."
    return 1

def singleton_tuple():
    "Not documentation.",
    return 1

#
def blank_comment():
    (("Kept despite blank comment."))
    return 1

def nested_string():
    if True:
        "Not documentation."
    return 1

def ranked_decoy():
    """reconcile_ledger reconcile_ledger reconcile_ledger"""
    return 1
